import { Fixtures } from '../../../../test/fixtures';
import { git, mocked, partial } from '../../../../test/util';
import { REPOSITORY_ARCHIVED } from '../../../constants/error-messages';
import type { BranchStatus } from '../../../types';
import { repoFingerprint } from '../util';
import { client as _client } from './client';
import {
  GerritChange,
  GerritChangeMessageInfo,
  GerritLabelTypeInfo,
  GerritProjectInfo,
  TAG_PULL_REQUEST_BODY,
} from './types';
import { mapGerritChangeToPr } from './utils';
import { mergeToConfig } from '.';
import * as gerrit from '.';

const gerritEndpointUrl = 'https://dev.gerrit.com/renovate';

const codeReviewLabel: GerritLabelTypeInfo = {
  values: {
    '-2': 'bad',
    '-1': 'unlikely',
    0: 'neutral',
    1: 'ok',
    2: 'good',
  },
  default_value: 0,
};

jest.mock('../../../util/git');
jest.mock('./client');
const clientMock = mocked(_client);

describe('modules/platform/gerrit/index', () => {
  beforeEach(async () => {
    mergeToConfig({
      repository: 'test/repo',
      labels: {},
    });
    await gerrit.initPlatform({
      endpoint: gerritEndpointUrl,
      username: 'user',
      password: 'pass',
    });
  });

  describe('initPlatform()', () => {
    it('should throw if no endpoint', () => {
      expect.assertions(1);
      expect(() => gerrit.initPlatform({})).toThrow();
    });

    it('should throw if no username/password', () => {
      expect.assertions(1);
      expect(() => gerrit.initPlatform({ endpoint: 'endpoint' })).toThrow();
    });

    it('should init', async () => {
      expect(
        await gerrit.initPlatform({
          endpoint: gerritEndpointUrl,
          username: 'abc',
          password: '123',
        })
      ).toMatchSnapshot();
    });
  });

  describe('getRepos()', () => {
    it('returns repos', async () => {
      clientMock.getRepos.mockResolvedValueOnce(['repo1', 'repo2']);
      expect(await gerrit.getRepos()).toEqual(['repo1', 'repo2']);
    });
  });

  it('initRepo() - inactive', async () => {
    clientMock.getProjectInfo.mockRejectedValueOnce(
      new Error(REPOSITORY_ARCHIVED)
    );
    await expect(gerrit.initRepo({ repository: 'test/repo' })).rejects.toThrow(
      REPOSITORY_ARCHIVED
    );
  });

  describe('initRepo()', () => {
    const projectInfo: GerritProjectInfo = {
      id: 'repo1',
      name: 'test-repo2',
    };

    beforeEach(() => {
      clientMock.getBranchInfo.mockResolvedValueOnce({
        ref: 'sha-hash....',
        revision: 'main',
      });
    });

    it('initRepo() - active', async () => {
      clientMock.getProjectInfo.mockResolvedValueOnce(projectInfo);
      clientMock.findChanges.mockResolvedValueOnce([]);
      expect(await gerrit.initRepo({ repository: 'test/repo' })).toEqual({
        defaultBranch: 'main',
        isFork: false,
        repoFingerprint: repoFingerprint(
          '',
          `${gerritEndpointUrl}/a/${encodeURIComponent('test/repo')}`
        ),
      });
      expect(git.initRepo).toHaveBeenCalledWith({
        url: 'https://dev.gerrit.com/renovate/a/test%2Frepo',
      });
      expect(git.syncGit).toHaveBeenCalled();
    });

    it('initRepo() - abandon rejected changes', async () => {
      clientMock.getProjectInfo.mockResolvedValueOnce({
        ...projectInfo,
        labels: { 'Code-Review': codeReviewLabel },
      });
      clientMock.findChanges.mockResolvedValueOnce([
        partial<GerritChange>({ _number: 1 }),
        partial<GerritChange>({ _number: 2 }),
      ]);

      await gerrit.initRepo({ repository: 'test/repo' });

      expect(clientMock.findChanges.mock.calls[0]).toEqual([
        [
          'owner:self',
          'project:test/repo',
          'status:open',
          'label:Code-Review=-2',
        ],
        undefined,
      ]);
      expect(clientMock.abandonChange.mock.calls).toEqual([[1], [2]]);
    });
  });

  describe('findPr()', () => {
    it('findPr() - no results', async () => {
      clientMock.findChanges.mockResolvedValueOnce([]);
      await expect(
        gerrit.findPr({ branchName: 'branch', state: 'open' })
      ).resolves.toBeNull();
      expect(clientMock.findChanges).toHaveBeenCalledWith(
        [
          'owner:self',
          'project:test/repo',
          'status:open',
          'hashtag:sourceBranch-branch',
        ],
        undefined
      );
    });

    it('findPr() - return the last change from search results', () => {
      clientMock.findChanges.mockResolvedValueOnce([
        partial<GerritChange>({ _number: 1 }),
        partial<GerritChange>({ _number: 2 }),
      ]);
      return expect(
        gerrit.findPr({ branchName: 'branch', state: 'open' })
      ).resolves.toHaveProperty('number', 2);
    });
  });

  describe('getPr()', () => {
    it('getPr() - found', async () => {
      const input = Fixtures.getJson('change-data.json');
      clientMock.getChange.mockResolvedValueOnce(input);
      await expect(gerrit.getPr(123456)).resolves.toEqual(
        mapGerritChangeToPr(input)
      );
      expect(clientMock.getChange).toHaveBeenCalledWith(123456);
    });

    it('getPr() - not found', () => {
      clientMock.getChange.mockRejectedValueOnce({ statusCode: 404 });
      return expect(gerrit.getPr(123456)).resolves.toBeNull();
    });

    it('getPr() - other error', () => {
      clientMock.getChange.mockRejectedValueOnce(new Error('other error'));
      return expect(gerrit.getPr(123456)).rejects.toThrow();
    });
  });

  describe('updatePr()', () => {
    beforeAll(() => {
      gerrit.mergeToConfig({ labels: {} });
    });

    it('updatePr() - new prTitle => copy to commit msg', async () => {
      const input = Fixtures.getJson('change-data.json');
      clientMock.getChange.mockResolvedValueOnce(input);
      await gerrit.updatePr({ number: 123456, prTitle: 'new title' });
      expect(clientMock.setCommitMessage).toHaveBeenCalledWith(
        123456,
        'new title\n\nChange-Id: ...\n'
      );
    });

    it('updatePr() - new prTitle => ignore copy to commit msg error', async () => {
      const input = Fixtures.getJson('change-data.json');
      clientMock.getChange.mockResolvedValueOnce(input);
      clientMock.setCommitMessage.mockRejectedValueOnce({ statusCode: 409 });
      await gerrit.updatePr({ number: 123456, prTitle: 'new title' });
      expect(clientMock.setCommitMessage).toHaveBeenCalled();
    });

    it('updatePr() - auto approve enabled', async () => {
      const input = Fixtures.getJson('change-data.json');
      clientMock.getChange.mockResolvedValueOnce(input);
      await gerrit.updatePr({
        number: 123456,
        prTitle: input.subject,
        platformOptions: {
          gerritAutoApprove: true,
        },
      });
      expect(clientMock.approveChange).toHaveBeenCalledWith(123456);
    });

    it('updatePr() - closed => abandon the change', async () => {
      const input = Fixtures.getJson('change-data.json');
      clientMock.getChange.mockResolvedValueOnce(input);
      await gerrit.updatePr({
        number: 123456,
        prTitle: input.subject,
        state: 'closed',
      });
      expect(clientMock.abandonChange).toHaveBeenCalledWith(123456);
    });

    it('updatePr() - existing prBody found in change.messages => nothing todo...', async () => {
      const input = Fixtures.getJson('change-data.json');
      clientMock.getChange.mockResolvedValueOnce(input);
      clientMock.getMessages.mockResolvedValueOnce([
        partial<GerritChangeMessageInfo>({
          tag: TAG_PULL_REQUEST_BODY,
          message: 'Last PR-Body',
        }),
      ]);
      await gerrit.updatePr({
        number: 123456,
        prTitle: input.subject,
        prBody: 'Last PR-Body',
      });
      expect(clientMock.addMessage).not.toHaveBeenCalled();
    });

    it('updatePr() - new prBody found in change.messages => add as message', async () => {
      const input = Fixtures.getJson('change-data.json');
      clientMock.getChange.mockResolvedValueOnce(input);
      clientMock.getMessages.mockResolvedValueOnce([]);
      await gerrit.updatePr({
        number: 123456,
        prTitle: input.subject,
        prBody: 'NEW PR-Body',
      });
      expect(clientMock.addMessage).toHaveBeenCalledWith(
        123456,
        'NEW PR-Body',
        TAG_PULL_REQUEST_BODY
      );
    });
  });

  describe('createPr() - error ', () => {
    it('createPr() - no existing found => rejects', () => {
      clientMock.findChanges.mockResolvedValueOnce([]);
      return expect(
        gerrit.createPr({
          sourceBranch: 'source',
          targetBranch: 'target',
          prTitle: 'title',
          prBody: 'body',
        })
      ).rejects.toThrow(
        `the change should be created automatically from previous push to refs/for/source`
      );
    });
  });

  describe('createPr() - success', () => {
    beforeAll(() => {
      gerrit.mergeToConfig({ labels: {} });
    });

    const input = Fixtures.getJson('change-data.json');

    beforeEach(() => {
      clientMock.findChanges.mockResolvedValueOnce([input]);
      clientMock.getChange.mockResolvedValueOnce(input);
      clientMock.getMessages.mockResolvedValueOnce([
        partial<GerritChangeMessageInfo>({
          tag: TAG_PULL_REQUEST_BODY,
          message: 'Last PR-Body',
        }),
      ]);
    });

    it('createPr() - update body/title WITHOUT approve', async () => {
      const pr = await gerrit.createPr({
        sourceBranch: 'source',
        targetBranch: 'target',
        prTitle: 'title',
        prBody: 'body',
        platformOptions: {
          gerritAutoApprove: false,
        },
      });
      expect(pr).toHaveProperty('number', 123456);
      expect(clientMock.addMessage).toHaveBeenCalledWith(
        123456,
        'body',
        TAG_PULL_REQUEST_BODY
      );
      expect(clientMock.approveChange).not.toHaveBeenCalled();
      expect(clientMock.setCommitMessage).toHaveBeenCalledWith(
        123456,
        'title\n\nChange-Id: ...\n'
      );
    });

    it('createPr() - update body and approve', async () => {
      const pr = await gerrit.createPr({
        sourceBranch: 'source',
        targetBranch: 'target',
        prTitle: input.subject,
        prBody: 'body',
        platformOptions: {
          gerritAutoApprove: true,
        },
      });
      expect(pr).toHaveProperty('number', 123456);
      expect(clientMock.addMessage).toHaveBeenCalledWith(
        123456,
        'body',
        TAG_PULL_REQUEST_BODY
      );
      expect(clientMock.approveChange).toHaveBeenCalledWith(123456);
      expect(clientMock.setCommitMessage).not.toHaveBeenCalled();
    });
  });

  describe('getBranchPr()', () => {
    it('getBranchPr() - no result', async () => {
      clientMock.findChanges.mockResolvedValue([]);
      await expect(
        gerrit.getBranchPr('renovate/dependency-1.x')
      ).resolves.toBeNull();
      expect(clientMock.findChanges).toHaveBeenCalledWith(
        [
          'owner:self',
          'project:test/repo',
          'status:open',
          'hashtag:sourceBranch-renovate/dependency-1.x',
        ],
        undefined
      );
    });

    it('getBranchPr() - found', () => {
      clientMock.findChanges.mockResolvedValue([
        Fixtures.getJson('change-data.json'),
      ]);
      return expect(
        gerrit.getBranchPr('renovate/dependency-1.x')
      ).resolves.toHaveProperty('number', 123456);
    });
  });

  describe('getPrList()', () => {
    it('getPrList() - empty list', async () => {
      clientMock.findChanges.mockResolvedValue([]);
      await expect(gerrit.getPrList()).resolves.toEqual([]);
      expect(clientMock.findChanges).toHaveBeenCalledWith(
        ['owner:self', 'project:test/repo', '-is:wip'],
        undefined
      );
    });

    it('getPrList() - multiple results', () => {
      const change = Fixtures.getJson('change-data.json');
      clientMock.findChanges.mockResolvedValue([change, change, change]);
      return expect(gerrit.getPrList()).resolves.toHaveLength(3);
    });
  });

  describe('mergePr()', () => {
    it('mergePr() - blocker by Verified', async () => {
      clientMock.submitChange.mockRejectedValueOnce({
        statusCode: 409,
        message: 'blocked by Verified',
      });
      await expect(gerrit.mergePr({ id: 123456 })).resolves.toBeFalse();
      expect(clientMock.submitChange).toHaveBeenCalledWith(123456);
    });

    it('mergePr() - success', () => {
      clientMock.submitChange.mockResolvedValueOnce(
        partial<GerritChange>({ status: 'MERGED' })
      );
      return expect(gerrit.mergePr({ id: 123456 })).resolves.toBeTrue();
    });

    it('mergePr() - other errors', () => {
      clientMock.submitChange.mockRejectedValueOnce(
        new Error('any other error')
      );
      return expect(gerrit.mergePr({ id: 123456 })).rejects.toThrow();
    });
  });

  describe('getBranchStatus()', () => {
    it('getBranchStatus() - branchname/change not found => yellow', () => {
      clientMock.findChanges.mockResolvedValueOnce([]);
      return expect(
        gerrit.getBranchStatus('renovate/dependency-1.x')
      ).resolves.toBe('yellow');
    });

    it('getBranchStatus() - branchname/changes found, submittable and not hasProblems => green', () => {
      const change = Fixtures.getJson('change-data.json');
      clientMock.findChanges.mockResolvedValueOnce([change]);
      return expect(
        gerrit.getBranchStatus('renovate/dependency-1.x')
      ).resolves.toBe('green');
    });

    it('getBranchStatus() - branchname/changes found and hasProblems => red', () => {
      const submittableChange = Fixtures.getJson('change-data.json');
      const changeWithProblems = { ...submittableChange };
      changeWithProblems.submittable = false;
      changeWithProblems.problems = [
        { message: 'error1' },
        { message: 'error2' },
      ];
      clientMock.findChanges.mockResolvedValueOnce([
        changeWithProblems,
        submittableChange,
      ]);
      return expect(
        gerrit.getBranchStatus('renovate/dependency-1.x')
      ).resolves.toBe('red');
    });
  });

  describe('getBranchStatusCheck()', () => {
    describe('GerritLabel is not available', () => {
      beforeAll(() => {
        mergeToConfig({ labels: {} });
      });

      it.each([
        'unknownCtx',
        'renovate/stability-days',
        'renovate/merge-confidence',
      ])('getBranchStatusCheck() - %s ', async (ctx) => {
        await expect(
          gerrit.getBranchStatusCheck('renovate/dependency-1.x', ctx)
        ).resolves.toBe('yellow');
        expect(clientMock.findChanges).not.toHaveBeenCalled();
      });
    });

    describe('GerritLabel is available', () => {
      beforeEach(() => {
        mergeToConfig({
          labelMappings: {
            stabilityDaysLabel: 'Renovate-Stability',
            mergeConfidenceLabel: 'Renovate-Merge-Confidence',
          },
          labels: {
            'Renovate-Stability': {
              values: { '0': 'default', '-1': 'Unstable', '1': 'Stable' },
              default_value: 0,
            },
            'Renovate-Merge-Confidence': {
              values: { '0': 'default', '-1': 'Unsatisfied', '1': 'Satisfied' },
              default_value: 0,
            },
          },
        });
      });

      it.each([
        {
          ctx: 'renovate/stability-days',
          labels: { 'Renovate-Stability': { rejected: {} } },
          expectedState: 'red' as BranchStatus,
        },
        {
          ctx: 'renovate/merge-confidence',
          labels: { 'Renovate-Merge-Confidence': { rejected: {} } },
          expectedState: 'red' as BranchStatus,
        },
        {
          ctx: 'renovate/stability-days',
          labels: { 'Renovate-Stability': { approved: {} } },
          expectedState: 'green' as BranchStatus,
        },
        {
          ctx: 'renovate/merge-confidence',
          labels: { 'Renovate-Merge-Confidence': { approved: {} } },
          expectedState: 'green' as BranchStatus,
        },
      ])('$ctx/$labels', ({ ctx, labels, expectedState }) => {
        const change = Fixtures.getJson('change-data.json');
        change.labels = { ...change.labels, ...labels };
        clientMock.findChanges.mockResolvedValueOnce([change]);
        return expect(
          gerrit.getBranchStatusCheck('renovate/dependency-1.x', ctx)
        ).resolves.toBe(expectedState);
      });
    });
  });

  describe('setBranchStatus()', () => {
    describe('GerritLabel is not available', () => {
      beforeEach(() => {
        mergeToConfig({ labels: {} });
      });

      it('setBranchStatus(renovate/stability-days)', async () => {
        await expect(
          gerrit.setBranchStatus({
            branchName: 'branch',
            context: 'renovate/stability-days',
            state: 'red',
            description: 'desc',
          })
        ).resolves.toBeUndefined();
        expect(clientMock.setLabel).not.toHaveBeenCalled();
      });

      it('setBranchStatus(renovate/merge-confidence)', () => {
        return expect(
          gerrit.setBranchStatus({
            branchName: 'branch',
            context: 'renovate/merge-confidence',
            state: 'red',
            description: 'desc',
          })
        ).resolves.toBeUndefined();
      });
    });

    describe('GerritLabel is available', () => {
      beforeEach(() => {
        mergeToConfig({
          labelMappings: {
            stabilityDaysLabel: 'Renovate-Stability',
            mergeConfidenceLabel: 'Renovate-Merge-Confidence',
          },
          labels: {
            'Renovate-Stability': {
              values: { '0': 'default', '-1': 'Unstable', '1': 'Stable' },
              default_value: 0,
            },
            'Renovate-Merge-Confidence': {
              values: { '0': 'default', '-1': 'Unsatisfied', '1': 'Satisfied' },
              default_value: 0,
            },
          },
        });
      });

      it.each([
        {
          ctx: 'renovate/stability-days',
          branchState: 'red' as BranchStatus,
          expectedVote: -1,
          expectedLabel: 'Renovate-Stability',
        },
        {
          ctx: 'renovate/stability-days',
          branchState: 'yellow' as BranchStatus,
          expectedVote: -1,
          expectedLabel: 'Renovate-Stability',
        },
        {
          ctx: 'renovate/stability-days',
          branchState: 'green' as BranchStatus,
          expectedVote: 1,
          expectedLabel: 'Renovate-Stability',
        },
        {
          ctx: 'renovate/merge-confidence',
          branchState: 'red' as BranchStatus,
          expectedVote: -1,
          expectedLabel: 'Renovate-Merge-Confidence',
        },
        {
          ctx: 'renovate/merge-confidence',
          branchState: 'yellow' as BranchStatus,
          expectedVote: -1,
          expectedLabel: 'Renovate-Merge-Confidence',
        },
        {
          ctx: 'renovate/merge-confidence',
          branchState: 'green' as BranchStatus,
          expectedVote: 1,
          expectedLabel: 'Renovate-Merge-Confidence',
        },
      ])(
        '$ctx/$branchState',
        async ({ ctx, branchState, expectedVote, expectedLabel }) => {
          clientMock.findChanges.mockResolvedValueOnce([
            Fixtures.getJson('change-data.json'),
          ]);
          await gerrit.setBranchStatus({
            branchName: 'renovate/dependency-1.x',
            context: ctx,
            state: branchState,
            description: 'desc',
          });
          expect(clientMock.setLabel).toHaveBeenCalledWith(
            123456,
            expectedLabel,
            expectedVote
          );
        }
      );

      it('no change found', async () => {
        clientMock.findChanges.mockResolvedValueOnce([]);
        await expect(
          gerrit.setBranchStatus({
            branchName: 'renovate/dependency-1.x',
            context: 'renovate/stability-days',
            state: 'red',
            description: 'desc',
          })
        ).resolves.toBeUndefined();
        expect(clientMock.setLabel).not.toHaveBeenCalled();
      });
    });
  });

  describe('addReviewers()', () => {
    it('addReviewers() - add reviewers', async () => {
      await expect(
        gerrit.addReviewers(123456, ['user1', 'user2'])
      ).resolves.toBeUndefined();
      expect(clientMock.addReviewer).toHaveBeenCalledTimes(2);
      expect(clientMock.addReviewer).toHaveBeenNthCalledWith(
        1,
        123456,
        'user1'
      );
      expect(clientMock.addReviewer).toHaveBeenNthCalledWith(
        2,
        123456,
        'user2'
      );
    });
  });

  describe('addAssignees()', () => {
    it('addAssignees() - set assignee', async () => {
      await expect(
        gerrit.addAssignees(123456, ['user1', 'user2'])
      ).resolves.toBeUndefined();
      expect(clientMock.addAssignee).toHaveBeenCalledTimes(1);
      expect(clientMock.addAssignee).toHaveBeenCalledWith(123456, 'user1');
    });
  });

  describe('ensureComment()', () => {
    it('ensureComment() - not exists => create new', async () => {
      clientMock.getMessages.mockResolvedValueOnce([]);
      await expect(
        gerrit.ensureComment({
          number: 123456,
          topic: null,
          content: 'My-Comment-Msg',
        })
      ).resolves.toBeTrue();
      expect(clientMock.addMessage).toHaveBeenCalledWith(
        123456,
        'My-Comment-Msg',
        undefined
      );
    });

    it('ensureComment() - already exists => dont create new', async () => {
      clientMock.getMessages.mockResolvedValueOnce([
        partial<GerritChangeMessageInfo>({
          tag: 'myTopic',
          message: 'My-Comment-Msg',
        }),
      ]);
      await expect(
        gerrit.ensureComment({
          number: 123456,
          topic: 'myTopic',
          content: ' My-Comment-Msg ',
        })
      ).resolves.toBeTrue();
      expect(clientMock.addMessage).not.toHaveBeenCalled();
    });
  });

  describe('getRawFile()', () => {
    beforeEach(() => {
      clientMock.getFile.mockResolvedValueOnce('{}');
    });

    it('getRawFile() - repo and branch', async () => {
      await expect(
        gerrit.getRawFile('renovate.json', 'test/repo', 'main')
      ).resolves.toBe('{}');
      expect(clientMock.getFile).toHaveBeenCalledWith(
        'test/repo',
        'main',
        'renovate.json'
      );
    });

    it('getRawFile() - repo/branch from config', async () => {
      mergeToConfig({
        repository: 'repo',
        head: 'master',
        labels: {},
      });
      await expect(gerrit.getRawFile('renovate.json')).resolves.toBe('{}');
      expect(clientMock.getFile).toHaveBeenCalledWith(
        'repo',
        'master',
        'renovate.json'
      );
    });

    it('getRawFile() - repo/branch defaults', async () => {
      mergeToConfig({
        repository: undefined,
        head: undefined,
        labels: {},
      });
      await expect(gerrit.getRawFile('renovate.json')).resolves.toBe('{}');
      expect(clientMock.getFile).toHaveBeenCalledWith(
        'All-Projects',
        'HEAD',
        'renovate.json'
      );
    });
  });

  describe('getJsonFile()', () => {
    //TODO: the wanted semantic is not clear
    it('getJsonFile()', () => {
      clientMock.getFile.mockResolvedValueOnce('{}');
      return expect(
        gerrit.getJsonFile('renovate.json', 'test/repo', 'main')
      ).resolves.toEqual({});
    });
  });

  describe('getRepoForceRebase()', () => {
    it('getRepoForceRebase()', () => {
      return expect(gerrit.getRepoForceRebase()).resolves.toBeFalse();
    });
  });

  describe('massageMarkdown()', () => {
    it('massageMarkdown()', () => {
      return expect(gerrit.massageMarkdown('Pull Requests')).toBe(
        'Change-Requests'
      );
    });
    //TODO: add some tests for Gerrit-specific replacements..
  });

  describe('currently unused/not-implemented functions', () => {
    it('deleteLabel()', () => {
      return expect(
        gerrit.deleteLabel(123456, 'label')
      ).resolves.toBeUndefined();
    });

    it('ensureCommentRemoval()', () => {
      return expect(
        gerrit.ensureCommentRemoval({
          type: 'by-topic',
          number: 123456,
          topic: 'topic',
        })
      ).resolves.toBeUndefined();
    });

    it('ensureIssueClosing()', () => {
      return expect(
        gerrit.ensureIssueClosing('title')
      ).resolves.toBeUndefined();
    });

    it('ensureIssue()', () => {
      return expect(
        gerrit.ensureIssue({ body: 'body', title: 'title' })
      ).resolves.toBeNull();
    });

    it('findIssue()', () => {
      return expect(gerrit.findIssue('title')).resolves.toBeNull();
    });

    it('getIssueList()', () => {
      return expect(gerrit.getIssueList()).resolves.toStrictEqual([]);
    });

    it('getVulnerabilityAlerts()', () => {
      return expect(gerrit.getVulnerabilityAlerts()).resolves.toStrictEqual([]);
    });
  });
});
