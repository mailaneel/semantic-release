import path from 'path';
import proxyquire from 'proxyquire';
import test from 'ava';
import {escapeRegExp} from 'lodash';
import {writeJson, readJson} from 'fs-extra';
import execa from 'execa';
import {WritableStreamBuffer} from 'stream-buffers';
import {SECRET_REPLACEMENT} from '../lib/definitions/constants';
import {gitHead, gitTagHead, gitRepo, gitCommits, gitRemoteTagHead, gitPush} from './helpers/git-utils';
import gitbox from './helpers/gitbox';
import mockServer from './helpers/mockserver';
import npmRegistry from './helpers/npm-registry';

/* eslint camelcase: ["error", {properties: "never"}] */

const requireNoCache = proxyquire.noPreserveCache();

// Environment variables used with semantic-release cli (similar to what a user would setup)
const env = {
  ...npmRegistry.authEnv,
  GH_TOKEN: gitbox.gitCredential,
  GITHUB_URL: mockServer.url,
  TRAVIS: 'true',
  CI: 'true',
  TRAVIS_BRANCH: 'master',
  TRAVIS_PULL_REQUEST: 'false',
};
// Environment variables used only for the local npm command used to do verification
const testEnv = {
  ...process.env,
  ...npmRegistry.authEnv,
  npm_config_registry: npmRegistry.url,
  LEGACY_TOKEN: Buffer.from(`${env.NPM_USERNAME}:${env.NPM_PASSWORD}`, 'utf8').toString('base64'),
};

const cli = require.resolve('../bin/semantic-release');
const pluginError = require.resolve('./fixtures/plugin-error');
const pluginInheritedError = require.resolve('./fixtures/plugin-error-inherited');
const pluginLogEnv = require.resolve('./fixtures/plugin-log-env');

test.before(async () => {
  await Promise.all([gitbox.start(), npmRegistry.start(), mockServer.start()]);
});

test.after.always(async () => {
  await Promise.all([gitbox.stop(), npmRegistry.stop(), mockServer.stop()]);
});

test('Release patch, minor and major versions', async t => {
  const packageName = 'test-release';
  const owner = 'git';
  // Create a git repository, set the current working directory at the root of the repo
  t.log('Create git repository and package.json');
  const {cwd, repositoryUrl, authUrl} = await gitbox.createRepo(packageName);
  // Create package.json in repository root
  await writeJson(path.resolve(cwd, 'package.json'), {
    name: packageName,
    version: '0.0.0-dev',
    repository: {url: repositoryUrl},
    publishConfig: {registry: npmRegistry.url},
    release: {success: false, fail: false},
  });
  // Create a npm-shrinkwrap.json file
  await execa('npm', ['shrinkwrap'], {env: testEnv, cwd});

  /* No release */
  let verifyMock = await mockServer.mock(
    `/repos/${owner}/${packageName}`,
    {headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}]},
    {body: {permissions: {push: true}}, method: 'GET'}
  );
  t.log('Commit a chore');
  await gitCommits(['chore: Init repository'], {cwd});
  t.log('$ semantic-release');
  let {stdout, code} = await execa(cli, [], {env, cwd});
  t.regex(stdout, /There are no relevant changes, so no new version is released/);
  t.is(code, 0);

  /* Initial release */
  let version = '1.0.0';
  verifyMock = await mockServer.mock(
    `/repos/${owner}/${packageName}`,
    {headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}]},
    {body: {permissions: {push: true}}, method: 'GET'}
  );
  let createReleaseMock = await mockServer.mock(
    `/repos/${owner}/${packageName}/releases`,
    {
      body: {tag_name: `v${version}`, target_commitish: 'master', name: `v${version}`},
      headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}],
    },
    {body: {html_url: `release-url/${version}`}}
  );

  t.log('Commit a feature');
  await gitCommits(['feat: Initial commit'], {cwd});
  t.log('$ semantic-release');
  ({stdout, code} = await execa(cli, [], {env, cwd}));
  t.regex(stdout, new RegExp(`Published GitHub release: release-url/${version}`));
  t.regex(stdout, new RegExp(`Publishing version ${version} to npm registry`));
  t.is(code, 0);

  // Verify package.json and npm-shrinkwrap.json have been updated
  t.is((await readJson(path.resolve(cwd, 'package.json'))).version, version);
  t.is((await readJson(path.resolve(cwd, 'npm-shrinkwrap.json'))).version, version);

  // Retrieve the published package from the registry and check version and gitHead
  let [, releasedVersion, releasedGitHead] = /^version = '(.+)'\s+gitHead = '(.+)'$/.exec(
    (await execa('npm', ['show', packageName, 'version', 'gitHead'], {env: testEnv, cwd})).stdout
  );
  let head = await gitHead({cwd});
  t.is(releasedVersion, version);
  t.is(releasedGitHead, head);
  t.is(await gitTagHead(`v${version}`, {cwd}), head);
  t.is(await gitRemoteTagHead(authUrl, `v${version}`, {cwd}), head);
  t.log(`+ released ${releasedVersion} with head ${releasedGitHead}`);

  await mockServer.verify(verifyMock);
  await mockServer.verify(createReleaseMock);

  /* Patch release */
  version = '1.0.1';
  verifyMock = await mockServer.mock(
    `/repos/${owner}/${packageName}`,
    {headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}]},
    {body: {permissions: {push: true}}, method: 'GET'}
  );
  createReleaseMock = await mockServer.mock(
    `/repos/${owner}/${packageName}/releases`,
    {
      body: {tag_name: `v${version}`, target_commitish: 'master', name: `v${version}`},
      headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}],
    },
    {body: {html_url: `release-url/${version}`}}
  );

  t.log('Commit a fix');
  await gitCommits(['fix: bar'], {cwd});
  t.log('$ semantic-release');
  ({stdout, code} = await execa(cli, [], {env, cwd}));
  t.regex(stdout, new RegExp(`Published GitHub release: release-url/${version}`));
  t.regex(stdout, new RegExp(`Publishing version ${version} to npm registry`));
  t.is(code, 0);

  // Verify package.json and npm-shrinkwrap.json have been updated
  t.is((await readJson(path.resolve(cwd, 'package.json'))).version, version);
  t.is((await readJson(path.resolve(cwd, 'npm-shrinkwrap.json'))).version, version);

  // Retrieve the published package from the registry and check version and gitHead
  [, releasedVersion, releasedGitHead] = /^version = '(.+)'\s+gitHead = '(.+)'$/.exec(
    (await execa('npm', ['show', packageName, 'version', 'gitHead'], {env: testEnv, cwd})).stdout
  );
  head = await gitHead({cwd});
  t.is(releasedVersion, version);
  t.is(releasedGitHead, head);
  t.is(await gitTagHead(`v${version}`, {cwd}), head);
  t.is(await gitRemoteTagHead(authUrl, `v${version}`, {cwd}), head);
  t.log(`+ released ${releasedVersion} with head ${releasedGitHead}`);

  await mockServer.verify(verifyMock);
  await mockServer.verify(createReleaseMock);

  /* Minor release */
  version = '1.1.0';
  verifyMock = await mockServer.mock(
    `/repos/${owner}/${packageName}`,
    {headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}]},
    {body: {permissions: {push: true}}, method: 'GET'}
  );
  createReleaseMock = await mockServer.mock(
    `/repos/${owner}/${packageName}/releases`,
    {
      body: {tag_name: `v${version}`, target_commitish: 'master', name: `v${version}`},
      headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}],
    },
    {body: {html_url: `release-url/${version}`}}
  );

  t.log('Commit a feature');
  await gitCommits(['feat: baz'], {cwd});
  t.log('$ semantic-release');
  ({stdout, code} = await execa(cli, [], {env, cwd}));
  t.regex(stdout, new RegExp(`Published GitHub release: release-url/${version}`));
  t.regex(stdout, new RegExp(`Publishing version ${version} to npm registry`));
  t.is(code, 0);

  // Verify package.json and npm-shrinkwrap.json have been updated
  t.is((await readJson(path.resolve(cwd, 'package.json'))).version, version);
  t.is((await readJson(path.resolve(cwd, 'npm-shrinkwrap.json'))).version, version);

  // Retrieve the published package from the registry and check version and gitHead
  [, releasedVersion, releasedGitHead] = /^version = '(.+)'\s+gitHead = '(.+)'$/.exec(
    (await execa('npm', ['show', packageName, 'version', 'gitHead'], {env: testEnv, cwd})).stdout
  );
  head = await gitHead({cwd});
  t.is(releasedVersion, version);
  t.is(releasedGitHead, head);
  t.is(await gitTagHead(`v${version}`, {cwd}), head);
  t.is(await gitRemoteTagHead(authUrl, `v${version}`, {cwd}), head);
  t.log(`+ released ${releasedVersion} with head ${releasedGitHead}`);

  await mockServer.verify(verifyMock);
  await mockServer.verify(createReleaseMock);

  /* Major release */
  version = '2.0.0';
  verifyMock = await mockServer.mock(
    `/repos/${owner}/${packageName}`,
    {headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}]},
    {body: {permissions: {push: true}}, method: 'GET'}
  );
  createReleaseMock = await mockServer.mock(
    `/repos/${owner}/${packageName}/releases`,
    {
      body: {tag_name: `v${version}`, target_commitish: 'master', name: `v${version}`},
      headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}],
    },
    {body: {html_url: `release-url/${version}`}}
  );

  t.log('Commit a breaking change');
  await gitCommits(['feat: foo\n\n BREAKING CHANGE: bar'], {cwd});
  t.log('$ semantic-release');
  ({stdout, code} = await execa(cli, [], {env, cwd}));
  t.regex(stdout, new RegExp(`Published GitHub release: release-url/${version}`));
  t.regex(stdout, new RegExp(`Publishing version ${version} to npm registry`));
  t.is(code, 0);

  // Verify package.json and npm-shrinkwrap.json have been updated
  t.is((await readJson(path.resolve(cwd, 'package.json'))).version, version);
  t.is((await readJson(path.resolve(cwd, 'npm-shrinkwrap.json'))).version, version);

  // Retrieve the published package from the registry and check version and gitHead
  [, releasedVersion, releasedGitHead] = /^version = '(.+)'\s+gitHead = '(.+)'$/.exec(
    (await execa('npm', ['show', packageName, 'version', 'gitHead'], {env: testEnv, cwd})).stdout
  );
  head = await gitHead({cwd});
  t.is(releasedVersion, version);
  t.is(releasedGitHead, head);
  t.is(await gitTagHead(`v${version}`, {cwd}), head);
  t.is(await gitRemoteTagHead(authUrl, `v${version}`, {cwd}), head);
  t.log(`+ released ${releasedVersion} with head ${releasedGitHead}`);

  await mockServer.verify(verifyMock);
  await mockServer.verify(createReleaseMock);
});

test('Exit with 1 if a plugin is not found', async t => {
  const packageName = 'test-plugin-not-found';
  const owner = 'test-repo';
  // Create a git repository, set the current working directory at the root of the repo
  t.log('Create git repository');
  const {cwd} = await gitRepo();
  await writeJson(path.resolve(cwd, 'package.json'), {
    name: packageName,
    version: '0.0.0-dev',
    repository: {url: `git+https://github.com/${owner}/${packageName}`},
    release: {analyzeCommits: 'non-existing-path', success: false, fail: false},
  });

  const {code, stderr} = await t.throwsAsync(execa(cli, [], {env, cwd}));
  t.is(code, 1);
  t.regex(stderr, /Cannot find module/);
});

test('Exit with 1 if a shareable config is not found', async t => {
  const packageName = 'test-config-not-found';
  const owner = 'test-repo';
  // Create a git repository, set the current working directory at the root of the repo
  t.log('Create git repository');
  const {cwd} = await gitRepo();
  await writeJson(path.resolve(cwd, 'package.json'), {
    name: packageName,
    version: '0.0.0-dev',
    repository: {url: `git+https://github.com/${owner}/${packageName}`},
    release: {extends: 'non-existing-path', success: false, fail: false},
  });

  const {code, stderr} = await t.throwsAsync(execa(cli, [], {env, cwd}));
  t.is(code, 1);
  t.regex(stderr, /Cannot find module/);
});

test('Exit with 1 if a shareable config reference a not found plugin', async t => {
  const packageName = 'test-config-ref-not-found';
  const owner = 'test-repo';
  const shareable = {analyzeCommits: 'non-existing-path'};

  // Create a git repository, set the current working directory at the root of the repo
  t.log('Create git repository');
  const {cwd} = await gitRepo();
  await writeJson(path.resolve(cwd, 'package.json'), {
    name: packageName,
    version: '0.0.0-dev',
    repository: {url: `git+https://github.com/${owner}/${packageName}`},
    release: {extends: './shareable.json', success: false, fail: false},
  });
  await writeJson(path.resolve(cwd, 'shareable.json'), shareable);

  const {code, stderr} = await t.throwsAsync(execa(cli, [], {env, cwd}));
  t.is(code, 1);
  t.regex(stderr, /Cannot find module/);
});

test('Dry-run', async t => {
  const packageName = 'test-dry-run';
  const owner = 'git';
  // Create a git repository, set the current working directory at the root of the repo
  t.log('Create git repository and package.json');
  const {cwd, repositoryUrl} = await gitbox.createRepo(packageName);
  // Create package.json in repository root
  await writeJson(path.resolve(cwd, 'package.json'), {
    name: packageName,
    version: '0.0.0-dev',
    repository: {url: repositoryUrl},
    publishConfig: {registry: npmRegistry.url},
    release: {success: false, fail: false},
  });

  /* Initial release */
  const verifyMock = await mockServer.mock(
    `/repos/${owner}/${packageName}`,
    {headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}]},
    {body: {permissions: {push: true}}, method: 'GET'}
  );
  const version = '1.0.0';
  t.log('Commit a feature');
  await gitCommits(['feat: Initial commit'], {cwd});
  t.log('$ semantic-release -d');
  const {stdout, code} = await execa(cli, ['-d'], {env, cwd});
  t.regex(stdout, new RegExp(`There is no previous release, the next release version is ${version}`));
  t.regex(stdout, new RegExp(`Release note for version ${version}`));
  t.regex(stdout, /Initial commit/);
  t.is(code, 0);

  // Verify package.json and has not been modified
  t.is((await readJson(path.resolve(cwd, 'package.json'))).version, '0.0.0-dev');
  await mockServer.verify(verifyMock);
});

test('Allow local releases with "noCi" option', async t => {
  const envNoCi = {...env};
  delete envNoCi.TRAVIS;
  delete envNoCi.CI;
  const packageName = 'test-no-ci';
  const owner = 'git';
  // Create a git repository, set the current working directory at the root of the repo
  t.log('Create git repository and package.json');
  const {cwd, repositoryUrl, authUrl} = await gitbox.createRepo(packageName);
  // Create package.json in repository root
  await writeJson(path.resolve(cwd, 'package.json'), {
    name: packageName,
    version: '0.0.0-dev',
    repository: {url: repositoryUrl},
    publishConfig: {registry: npmRegistry.url},
    release: {success: false, fail: false},
  });

  /* Initial release */
  const version = '1.0.0';
  const verifyMock = await mockServer.mock(
    `/repos/${owner}/${packageName}`,
    {headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}]},
    {body: {permissions: {push: true}}, method: 'GET'}
  );
  const createReleaseMock = await mockServer.mock(
    `/repos/${owner}/${packageName}/releases`,
    {
      body: {tag_name: `v${version}`, target_commitish: 'master', name: `v${version}`},
      headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}],
    },
    {body: {html_url: `release-url/${version}`}}
  );

  t.log('Commit a feature');
  await gitCommits(['feat: Initial commit'], {cwd});
  t.log('$ semantic-release --no-ci');
  const {stdout, code} = await execa(cli, ['--no-ci'], {env: envNoCi, cwd});
  t.regex(stdout, new RegExp(`Published GitHub release: release-url/${version}`));
  t.regex(stdout, new RegExp(`Publishing version ${version} to npm registry`));
  t.is(code, 0);

  // Verify package.json and has been updated
  t.is((await readJson(path.resolve(cwd, 'package.json'))).version, version);

  // Retrieve the published package from the registry and check version and gitHead
  const [, releasedVersion, releasedGitHead] = /^version = '(.+)'\s+gitHead = '(.+)'$/.exec(
    (await execa('npm', ['show', packageName, 'version', 'gitHead'], {env: testEnv, cwd})).stdout
  );

  const head = await gitHead({cwd});
  t.is(releasedVersion, version);
  t.is(releasedGitHead, head);
  t.is(await gitTagHead(`v${version}`, {cwd}), head);
  t.is(await gitRemoteTagHead(authUrl, `v${version}`, {cwd}), head);
  t.log(`+ released ${releasedVersion} with head ${releasedGitHead}`);

  await mockServer.verify(verifyMock);
  await mockServer.verify(createReleaseMock);
});

test('Pass options via CLI arguments', async t => {
  const packageName = 'test-cli';
  // Create a git repository, set the current working directory at the root of the repo
  t.log('Create git repository and package.json');
  const {cwd, repositoryUrl, authUrl} = await gitbox.createRepo(packageName);
  // Create package.json in repository root
  await writeJson(path.resolve(cwd, 'package.json'), {
    name: packageName,
    version: '0.0.0-dev',
    repository: {url: repositoryUrl},
    publishConfig: {registry: npmRegistry.url},
  });

  /* Initial release */
  const version = '1.0.0';
  t.log('Commit a feature');
  await gitCommits(['feat: Initial commit'], {cwd});
  t.log('$ semantic-release');
  const {stdout, code} = await execa(
    cli,
    [
      '--verify-conditions',
      '@semantic-release/npm',
      '--publish',
      '@semantic-release/npm',
      `--success`,
      false,
      `--fail`,
      false,
      '--debug',
    ],
    {env, cwd}
  );
  t.regex(stdout, new RegExp(`Publishing version ${version} to npm registry`));
  t.is(code, 0);

  // Verify package.json and has been updated
  t.is((await readJson(path.resolve(cwd, 'package.json'))).version, version);

  // Retrieve the published package from the registry and check version and gitHead
  const [, releasedVersion, releasedGitHead] = /^version = '(.+)'\s+gitHead = '(.+)'$/.exec(
    (await execa('npm', ['show', packageName, 'version', 'gitHead'], {env: testEnv, cwd})).stdout
  );
  const head = await gitHead({cwd});
  t.is(releasedVersion, version);
  t.is(releasedGitHead, head);
  t.is(await gitTagHead(`v${version}`, {cwd}), head);
  t.is(await gitRemoteTagHead(authUrl, `v${version}`, {cwd}), head);
  t.log(`+ released ${releasedVersion} with head ${releasedGitHead}`);
});

test('Run via JS API', async t => {
  const semanticRelease = requireNoCache('..', {
    './lib/logger': {log: () => {}, error: () => {}, stdout: () => {}},
    'env-ci': () => ({isCi: true, branch: 'master', isPr: false}),
  });
  const packageName = 'test-js-api';
  const owner = 'git';
  // Create a git repository, set the current working directory at the root of the repo
  t.log('Create git repository and package.json');
  const {cwd, repositoryUrl, authUrl} = await gitbox.createRepo(packageName);
  // Create package.json in repository root
  await writeJson(path.resolve(cwd, 'package.json'), {
    name: packageName,
    version: '0.0.0-dev',
    repository: {url: repositoryUrl},
    publishConfig: {registry: npmRegistry.url},
    release: {
      fail: false,
      success: false,
    },
  });

  /* Initial release */
  const version = '1.0.0';
  const verifyMock = await mockServer.mock(
    `/repos/${owner}/${packageName}`,
    {headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}]},
    {body: {permissions: {push: true}}, method: 'GET'}
  );
  const createReleaseMock = await mockServer.mock(
    `/repos/${owner}/${packageName}/releases`,
    {
      body: {tag_name: `v${version}`, target_commitish: 'master', name: `v${version}`},
      headers: [{name: 'Authorization', values: [`token ${env.GH_TOKEN}`]}],
    },
    {body: {html_url: `release-url/${version}`}}
  );

  t.log('Commit a feature');
  await gitCommits(['feat: Initial commit'], {cwd});
  t.log('$ Call semantic-release via API');
  await semanticRelease(undefined, {cwd, env, stdout: new WritableStreamBuffer(), stderr: new WritableStreamBuffer()});

  // Verify package.json and has been updated
  t.is((await readJson(path.resolve(cwd, 'package.json'))).version, version);

  // Retrieve the published package from the registry and check version and gitHead
  const [, releasedVersion, releasedGitHead] = /^version = '(.+)'\s+gitHead = '(.+)'$/.exec(
    (await execa('npm', ['show', packageName, 'version', 'gitHead'], {env: testEnv, cwd})).stdout
  );
  const head = await gitHead({cwd});
  t.is(releasedVersion, version);
  t.is(releasedGitHead, head);
  t.is(await gitTagHead(`v${version}`, {cwd}), head);
  t.is(await gitRemoteTagHead(authUrl, `v${version}`, {cwd}), head);
  t.log(`+ released ${releasedVersion} with head ${releasedGitHead}`);

  await mockServer.verify(verifyMock);
  await mockServer.verify(createReleaseMock);
});

test('Log unexpected errors from plugins and exit with 1', async t => {
  const packageName = 'test-unexpected-error';
  // Create a git repository, set the current working directory at the root of the repo
  t.log('Create git repository and package.json');
  const {cwd, repositoryUrl} = await gitbox.createRepo(packageName);
  // Create package.json in repository root
  await writeJson(path.resolve(cwd, 'package.json'), {
    name: packageName,
    version: '0.0.0-dev',
    repository: {url: repositoryUrl},
    release: {verifyConditions: pluginError, fail: false, success: false},
  });

  /* Initial release */
  t.log('Commit a feature');
  await gitCommits(['feat: Initial commit'], {cwd});
  t.log('$ semantic-release');
  const {stderr, code} = await execa(cli, [], {env, cwd, reject: false});
  // Verify the type and message are logged
  t.regex(stderr, /Error: a/);
  // Verify the the stacktrace is logged
  t.regex(stderr, new RegExp(pluginError));
  // Verify the Error properties are logged
  t.regex(stderr, /errorProperty: 'errorProperty'/);
  t.is(code, 1);
});

test('Log errors inheriting SemanticReleaseError and exit with 1', async t => {
  const packageName = 'test-inherited-error';
  // Create a git repository, set the current working directory at the root of the repo
  t.log('Create git repository and package.json');
  const {cwd, repositoryUrl} = await gitbox.createRepo(packageName);
  // Create package.json in repository root
  await writeJson(path.resolve(cwd, 'package.json'), {
    name: packageName,
    version: '0.0.0-dev',
    repository: {url: repositoryUrl},
    release: {verifyConditions: pluginInheritedError, fail: false, success: false},
  });

  /* Initial release */
  t.log('Commit a feature');
  await gitCommits(['feat: Initial commit'], {cwd});
  t.log('$ semantic-release');
  const {stderr, code} = await execa(cli, [], {env, cwd, reject: false});
  // Verify the type and message are logged
  t.regex(stderr, /EINHERITED Inherited error/);
  t.is(code, 1);
});

test('Exit with 1 if missing permission to push to the remote repository', async t => {
  const packageName = 'unauthorized';
  // Create a git repository, set the current working directory at the root of the repo
  t.log('Create git repository');
  const {cwd} = await gitbox.createRepo(packageName);
  await writeJson(path.resolve(cwd, 'package.json'), {name: packageName, version: '0.0.0-dev'});

  /* Initial release */
  t.log('Commit a feature');
  await gitCommits(['feat: Initial commit'], {cwd});
  await gitPush('origin', 'master', {cwd});
  t.log('$ semantic-release');
  const {stderr, code} = await execa(
    cli,
    ['--repository-url', 'http://user:wrong_pass@localhost:2080/git/unauthorized.git'],
    {env: {...env, GH_TOKEN: 'user:wrong_pass'}, cwd, reject: false}
  );
  // Verify the type and message are logged
  t.regex(stderr, /EGITNOPERMISSION/);
  t.is(code, 1);
});

test('Hide sensitive environment variable values from the logs', async t => {
  const packageName = 'log-secret';
  // Create a git repository, set the current working directory at the root of the repo
  t.log('Create git repository');
  const {cwd, repositoryUrl} = await gitbox.createRepo(packageName);
  await writeJson(path.resolve(cwd, 'package.json'), {
    name: packageName,
    version: '0.0.0-dev',
    repository: {url: repositoryUrl},
    release: {verifyConditions: [pluginLogEnv], fail: false, success: false},
  });

  t.log('$ semantic-release');
  const {stdout, stderr} = await execa(cli, [], {env: {...env, MY_TOKEN: 'secret token'}, cwd, reject: false});

  t.regex(stdout, new RegExp(`Console: Exposing token ${escapeRegExp(SECRET_REPLACEMENT)}`));
  t.regex(stdout, new RegExp(`Log: Exposing token ${escapeRegExp(SECRET_REPLACEMENT)}`));
  t.regex(stderr, new RegExp(`Error: Console token ${escapeRegExp(SECRET_REPLACEMENT)}`));
  t.regex(stderr, new RegExp(`Throw error: Exposing ${escapeRegExp(SECRET_REPLACEMENT)}`));
});
