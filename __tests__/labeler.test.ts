import {checkGlobs} from '../src/labeler';

import * as core from '@actions/core';

jest.mock('@actions/core');

beforeAll(() => {
  jest.spyOn(core, 'getInput').mockImplementation((name, options) => {
    return jest.requireActual('@actions/core').getInput(name, options);
  });
});

const matchConfig = [{any: ['*.txt']}];

describe('checkGlobs', () => {
    it('returns true when our pattern does match changed files', () => {
      const changedFiles = ['foo.txt', 'bar.txt'];
      const result = checkGlobs(changedFiles, matchConfig, false);
      
      expect(result[0]).toBeTruthy();
    });
    
    it('returns false when our pattern does not match changed files', () => {
      const changedFiles = ['foo.docx'];
      const result = checkGlobs(changedFiles, matchConfig, false);
 
      expect(result[0]).toBeFalsy();
    });

    it('returns false for a file starting with dot if `dot` option is false', () => {
      const changedFiles = ['.foo.txt'];
      const result = checkGlobs(changedFiles, matchConfig, false);

      expect(result[0]).toBeFalsy();
    });

    it('returns true for a file starting with dot if `dot` option is true', () => {
      const changedFiles = ['.foo.txt'];
      const result = checkGlobs(changedFiles, matchConfig, true);

      expect(result[0]).toBeTruthy();
    });

    it('non matching files are correct when no match', () => {
      const changedFiles = ['file.pdf'];
      const result = checkGlobs(changedFiles, matchConfig, false);

      expect(result[1]).toEqual(changedFiles);
    });

    it('non matching files are empty when everything matched', () => {
      const changedFiles = ['file.txt'];
      const result = checkGlobs(changedFiles, matchConfig, false);

      expect(result[1]).toEqual([]);
    });

    it('non matching files include all valid values', () => {
      const config = [
        {any: ['*.txt', '!file.txt']},
        {any: ['folder/**/*', '!folder/**/file']}
      ];
      const changedFiles = ['folder/subfolder/file', 'folder/subfolder/otherfile', 'file.txt', 'file.pdf'];
      const result = checkGlobs(changedFiles, config, false);

      expect(result[1].sort()).toEqual(['file.txt', 'file.pdf', 'folder/subfolder/file'].sort());
    });
});
