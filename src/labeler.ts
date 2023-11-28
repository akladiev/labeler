import * as core from '@actions/core';
import * as github from '@actions/github';
import * as pluginRetry from '@octokit/plugin-retry';
import * as yaml from 'js-yaml';
import fs from 'fs';
import {Minimatch} from 'minimatch';

interface MatchConfig {
  all?: string[];
  any?: string[];
}

type StringOrMatchConfig = string | MatchConfig;
type ClientType = ReturnType<typeof github.getOctokit>;

// GitHub Issues cannot have more than 100 labels
const GITHUB_MAX_LABELS = 100;

export async function run() {
  try {
    const token = core.getInput('repo-token');
    const configPath = core.getInput('configuration-path', {required: true});
    const syncLabels = !!core.getInput('sync-labels');
    const dot = core.getBooleanInput('dot');
    const nonMatchingLabel = core.getInput('non-matching-label');

    const prNumbers = getPrNumbers();
    if (!prNumbers.length) {
      core.warning('Could not get pull request number(s), exiting');
      return;
    }

    const client: ClientType = github.getOctokit(token, {}, pluginRetry.retry);

    for (const prNumber of prNumbers) {
      core.debug(`looking for pr #${prNumber}`);
      let pullRequest: any;
      try {
        const result = await client.rest.pulls.get({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          pull_number: prNumber
        });
        pullRequest = result.data;
      } catch (error: any) {
        core.warning(`Could not find pull request #${prNumber}, skipping`);
        continue;
      }

      core.debug(`fetching changed files for pr #${prNumber}`);
      const changedFiles: string[] = await getChangedFiles(client, prNumber);
      if (!changedFiles.length) {
        core.warning(
          `Pull request #${prNumber} has no changed files, skipping`
        );
        continue;
      }

      const labelGlobs: Map<string, StringOrMatchConfig[]> =
        await getLabelGlobs(client, configPath);

      const preexistingLabels = pullRequest.labels.map(l => l.name);
      const allLabels: Set<string> = new Set<string>(preexistingLabels);

      let nonMatching: string[][] = [];

      for (const [label, globs] of labelGlobs.entries()) {
        core.debug(`processing ${label}`);
        const checkGlobsResult = checkGlobs(changedFiles, globs, dot);
        const matches = checkGlobsResult[0];
        const nonMatchingFiles = checkGlobsResult[1];

        if (matches) {
          allLabels.add(label);
        } else if (syncLabels) {
          allLabels.delete(label);
        }

        nonMatching.push(nonMatchingFiles);
      }

      nonMatching = arrayIntersection(nonMatching);
      core.debug(`Files that didn't match any of the patterns: ${nonMatching}`);

      if (
        nonMatchingLabel &&
        nonMatchingLabel.length > 0 &&
        nonMatching.length
      ) {
        core.debug(`  adding ${nonMatchingLabel}`);
        allLabels.add(nonMatchingLabel);
      } else if (syncLabels) {
        allLabels.delete(nonMatchingLabel);
      }

      const labelsToAdd = [...allLabels].slice(0, GITHUB_MAX_LABELS);
      const excessLabels = [...allLabels].slice(GITHUB_MAX_LABELS);

      try {
        let newLabels: string[] = [];

        if (!isListEqual(labelsToAdd, preexistingLabels)) {
          await setLabels(client, prNumber, labelsToAdd);
          newLabels = labelsToAdd.filter(l => !preexistingLabels.includes(l));
        }

        core.setOutput('new-labels', newLabels.join(','));
        core.setOutput('all-labels', labelsToAdd.join(','));

        if (excessLabels.length) {
          core.warning(
            `Maximum of ${GITHUB_MAX_LABELS} labels allowed. Excess labels: ${excessLabels.join(
              ', '
            )}`,
            {title: 'Label limit for a PR exceeded'}
          );
        }
      } catch (error: any) {
        if (
          error.name === 'HttpError' &&
          error.message === 'Resource not accessible by integration'
        ) {
          core.warning(
            `The action requires write permission to add labels to pull requests. For more information please refer to the action documentation: https://github.com/actions/labeler#permissions`,
            {
              title: `${process.env['GITHUB_ACTION_REPOSITORY']} running under '${github.context.eventName}' is misconfigured`
            }
          );
          core.setFailed(error.message);
        } else {
          throw error;
        }
      }
    }
  } catch (error: any) {
    core.error(error);
    core.setFailed(error.message);
  }
}

function getPrNumbers(): number[] {
  const pullRequestNumbers = core.getMultilineInput('pr-number');
  if (pullRequestNumbers && pullRequestNumbers.length) {
    const prNumbers: number[] = [];

    for (const prNumber of pullRequestNumbers) {
      const prNumberInt = parseInt(prNumber, 10);
      if (isNaN(prNumberInt) || prNumberInt <= 0) {
        core.warning(`'${prNumber}' is not a valid pull request number`);
      } else {
        prNumbers.push(prNumberInt);
      }
    }

    return prNumbers;
  }

  const pullRequest = github.context.payload.pull_request;
  if (!pullRequest) {
    return [];
  }

  return [pullRequest.number];
}

async function getChangedFiles(
  client: ClientType,
  prNumber: number
): Promise<string[]> {
  const listFilesOptions = client.rest.pulls.listFiles.endpoint.merge({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber
  });

  const listFilesResponse = await client.paginate(listFilesOptions);
  const changedFiles = listFilesResponse.map((f: any) => f.filename);

  core.debug('found changed files:');
  for (const file of changedFiles) {
    core.debug('  ' + file);
  }

  return changedFiles;
}

async function getLabelGlobs(
  client: ClientType,
  configurationPath: string
): Promise<Map<string, StringOrMatchConfig[]>> {
  let configurationContent: string;
  try {
    if (!fs.existsSync(configurationPath)) {
      core.info(
        `The configuration file (path: ${configurationPath}) isn't not found locally, fetching via the api`
      );
      configurationContent = await fetchContent(client, configurationPath);
    } else {
      core.info(
        `The configuration file (path: ${configurationPath}) is found locally, reading from the file`
      );
      configurationContent = fs.readFileSync(configurationPath, {
        encoding: 'utf8'
      });
    }
  } catch (e: any) {
    if (e.name == 'HttpError' || e.name == 'NotFound') {
      core.warning(
        `The config file was not found at ${configurationPath}. Make sure it exists and that this action has the correct access rights.`
      );
    }
    throw e;
  }

  // loads (hopefully) a `{[label:string]: string | StringOrMatchConfig[]}`, but is `any`:
  const configObject: any = yaml.load(configurationContent);

  // transform `any` => `Map<string,StringOrMatchConfig[]>` or throw if yaml is malformed:
  return getLabelGlobMapFromObject(configObject);
}

async function fetchContent(
  client: ClientType,
  repoPath: string
): Promise<string> {
  const response: any = await client.rest.repos.getContent({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: repoPath,
    ref: github.context.sha
  });

  return Buffer.from(response.data.content, response.data.encoding).toString();
}

function getGlobsAsArray(label: string, configObject: any) {
  for (const label in configObject) {
    if (typeof configObject[label] === 'string') {
      return [configObject[label]];
    } else if (configObject[label] instanceof Array) {
      return configObject[label];
    } else {
      throw Error(
        `found unexpected type for label ${label} (should be string or array of globs)`
      );
    }
  }
}

function resolveAnchorsLowLevel(entries: string[], configObject: any) {
  let resolved: string[] = [];
  for (const entry in entries) {
    const isAnchor: boolean = entry[0] === '&';
    if (isAnchor === true) {
      const targetLabel = entry.substring(1);
      // TODO: add recursive call of resolveAnchorsLowLevel?
      const targetLabelGlobs = getGlobsAsArray(targetLabel, configObject);
      resolved = resolved.concat(targetLabelGlobs);
    }
    else {
      resolved.push(entry);
    }
  }
  return resolved;
}

function resolveAnchors(labelGlobs: Map<string, StringOrMatchConfig[]>, configObject: any) {
  let labelGlobsUnwrapped: Map<string, StringOrMatchConfig[]> = new Map();
  for (const label in labelGlobs) {
    let contentResolved: StringOrMatchConfig[] = [];
    for (const content in labelGlobs[label]) {
      const matchConfig: MatchConfig = toMatchConfig(content);
      if (matchConfig.all !== undefined) {
        const globsResolved: string[] = resolveAnchorsLowLevel(matchConfig.all, configObject);
        matchConfig.all = globsResolved
      }
      if (matchConfig.any !== undefined) {
        const globsResolved: string[] = resolveAnchorsLowLevel(matchConfig.any, configObject);
        matchConfig.any = globsResolved
      }
      contentResolved.push(matchConfig)
    }
    labelGlobsUnwrapped.set(label, contentResolved);
  }
  return labelGlobsUnwrapped
}

function getLabelGlobMapFromObject(
  configObject: any
): Map<string, StringOrMatchConfig[]> {
  const labelGlobs: Map<string, StringOrMatchConfig[]> = new Map();
  for (const label in configObject) {
    labelGlobs.set(label, getGlobsAsArray(label, configObject));
  }
  const labelGlobsUnwrapped = resolveAnchors(labelGlobs, configObject)
  return labelGlobsUnwrapped;
}

function toMatchConfig(config: StringOrMatchConfig): MatchConfig {
  if (typeof config === 'string') {
    return {
      any: [config]
    };
  }

  return config;
}

function printPattern(matcher: Minimatch): string {
  return (matcher.negate ? '!' : '') + matcher.pattern;
}

function arrayIntersection(arrays: any[][]): any[] {
  if (arrays.length === 0) {
    return [];
  }
  let intersection = arrays[0];
  for (let i = 1; i < arrays.length; i++) {
    intersection = intersection.filter(element => arrays[i].includes(element));
  }
  return intersection;
}

export function checkGlobs(
  changedFiles: string[],
  globs: StringOrMatchConfig[],
  dot: boolean
): [boolean, string[]] {
  let nonMatchingFilesForEachGlob: string[][] = [];
  let matches: boolean = false;
  for (const glob of globs) {
    core.debug(` checking pattern ${JSON.stringify(glob)}`);
    const matchConfig = toMatchConfig(glob);
    const matchResult: [boolean, string[]] = checkMatch(
      changedFiles,
      matchConfig,
      dot
    );
    const matchesByGlob = matchResult[0];
    const nonMatchingFilesByGlob = matchResult[1];
    nonMatchingFilesForEachGlob.push(nonMatchingFilesByGlob);
    core.debug(
      `    non-matching files for glob ${JSON.stringify(
        glob
      )}: ${nonMatchingFilesByGlob}`
    );
    if (matchesByGlob) {
      matches = true;
    }
  }

  const nonMatchingFiles: string[] = arrayIntersection(
    nonMatchingFilesForEachGlob
  );
  core.debug(`  non-matching files for all globs: ${nonMatchingFiles}`);
  return [matches, nonMatchingFiles];
}

function isMatch(changedFile: string, matchers: Minimatch[]): boolean {
  core.debug(`    matching patterns against file ${changedFile}`);
  for (const matcher of matchers) {
    core.debug(`   - ${printPattern(matcher)}`);
    if (!matcher.match(changedFile)) {
      core.debug(`   ${printPattern(matcher)} did not match`);
      return false;
    }
  }

  core.debug(`   all patterns matched`);
  return true;
}

// equivalent to "Array.some()" but expanded for debugging and clarity
function checkAny(
  changedFiles: string[],
  globs: string[],
  dot: boolean
): [boolean, string[]] {
  const matchers = globs.map(g => new Minimatch(g, {dot}));
  core.debug(`  checking "any" patterns`);

  let nonMatchingFiles: string[] = [];
  let matches: boolean = false;
  for (const changedFile of changedFiles) {
    if (isMatch(changedFile, matchers)) {
      core.debug(`  "any" patterns matched against ${changedFile}`);
      matches = true;
    } else {
      nonMatchingFiles.push(changedFile);
    }
  }

  if (!matches) {
    core.debug(`  "any" patterns did not match any files`);
  }
  core.debug(`  non-matching files by "any": ${nonMatchingFiles}`);
  return [matches, nonMatchingFiles];
}

// equivalent to "Array.every()" but expanded for debugging and clarity
function checkAll(
  changedFiles: string[],
  globs: string[],
  dot: boolean
): [boolean, string[]] {
  const matchers = globs.map(g => new Minimatch(g, {dot}));
  core.debug(` checking "all" patterns`);

  let nonMatchingFiles: string[] = [];
  let matches: boolean = true;
  for (const changedFile of changedFiles) {
    if (!isMatch(changedFile, matchers)) {
      core.debug(`  "all" patterns did not match against ${changedFile}`);
      matches = false;
      nonMatchingFiles.push(changedFile);
    }
  }
  if (matches) {
    core.debug(`  "all" patterns matched all files`);
  }
  core.debug(`  non-matching files by "all": ${nonMatchingFiles}`);
  return [matches, nonMatchingFiles];
}

function checkMatch(
  changedFiles: string[],
  matchConfig: MatchConfig,
  dot: boolean
): [boolean, string[]] {
  let matches: boolean = true;
  let nonMatchingFiles: string[][] = [];

  if (matchConfig.all !== undefined) {
    const checkResult: [boolean, string[]] = checkAll(
      changedFiles,
      matchConfig.all,
      dot
    );
    const matchesByAll = checkResult[0];
    nonMatchingFiles.push(checkResult[1]);
    if (!matchesByAll) {
      matches = false;
    }
  }

  if (matches && matchConfig.any !== undefined) {
    const checkResult: [boolean, string[]] = checkAny(
      changedFiles,
      matchConfig.any,
      dot
    );
    const matchesByAny = checkResult[0];
    nonMatchingFiles.push(checkResult[1]);
    if (!matchesByAny) {
      matches = false;
    }
  }

  const nonMatching: string[] = arrayIntersection(nonMatchingFiles);
  core.debug(
    ` non-matching files by ${JSON.stringify(matchConfig)}: ${nonMatchingFiles}`
  );

  return [matches, nonMatching];
}

function isListEqual(listA: string[], listB: string[]): boolean {
  return listA.length === listB.length && listA.every(el => listB.includes(el));
}

async function setLabels(
  client: ClientType,
  prNumber: number,
  labels: string[]
) {
  await client.rest.issues.setLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: prNumber,
    labels: labels
  });
}
