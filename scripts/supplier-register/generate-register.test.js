// SPDX-License-Identifier: Apache-2.0
// © Crown Copyright 2026. This work has been developed by the National Digital Twin Programme
// and is legally attributed to the Department for Business and Trade (UK) as the governing entity.

/*
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  extractTextFromTokens,
  recordSupplier,
  parseSuppliersFromMarkdown,
  isOrgContributionSection,
  extractSuppliersFromList,
  fetchAcknowledgements,
  setupOctokit,
  detectDuplicates,
  writeSupplierRegister,
  generateJobSummary
} = require('./generate-register.js');

test('extractTextFromTokens', async (t) => {
  await t.test('extracts text from plain text tokens', () => {
    // arrange
    const tokens = [{ type: 'text', text: 'National Digital Twin' }];

    // act
    const result = extractTextFromTokens(tokens);

    // assert
    assert.strictEqual(result, 'National Digital Twin');
  });

  await t.test('extracts text from strong and em formatting elements', () => {
    // arrange
    const tokens = [
      { type: 'strong', tokens: [{ type: 'text', text: 'Bold' }] },
      { type: 'em', text: 'Italics' }, // Testing the fallback to .text when no .tokens exist inside the element
    ];

    // act
    const result = extractTextFromTokens(tokens);

    // assert
    assert.strictEqual(result, 'BoldItalics');
  });

  await t.test('extracts text crawling deep nested unhandled tokens', () => {
    // arrange
    const tokens = [
      { type: 'unknown', tokens: [{ type: 'text', text: 'Nested' }] }
    ];

    // act
    const result = extractTextFromTokens(tokens);

    // assert
    assert.strictEqual(result, 'Nested');
  });

  await t.test('extracts text from link tokens', () => {
    // arrange
    const tokens = [{
      type: 'link',
      tokens: [{ type: 'text', text: 'Connected Digital Twins' }]
    }];

    // act
    const result = extractTextFromTokens(tokens);

    // assert
    assert.strictEqual(result, 'Connected Digital Twins');
  });

  await t.test('returns empty string if no tokens', () => {
    // arrange
    const tokens = null;

    // act
    const result = extractTextFromTokens(tokens);

    // assert
    assert.strictEqual(result, '');
  });
});

test('recordSupplier', async (t) => {
  await t.test('adds a new supplier', () => {
    // arrange
    const map = new Map();

    // act
    recordSupplier(map, 'Supplier A', 'repo1');

    // assert
    assert.strictEqual(map.size, 1);
    const data = map.get('supplier a');
    assert.deepStrictEqual(data, { display: 'Supplier A', repos: ['repo1'] });
  });

  await t.test('adds a repository to an existing supplier', () => {
    // arrange
    const map = new Map();
    recordSupplier(map, 'Supplier A', 'repo1'); // Setup initial state

    // act
    recordSupplier(map, 'Supplier A', 'repo2');

    // assert
    assert.strictEqual(map.size, 1);
    const data = map.get('supplier a');
    assert.deepStrictEqual(data.repos, ['repo1', 'repo2']);
  });

  await t.test('prefers capitalised version of the name', () => {
    // arrange
    const map = new Map();
    recordSupplier(map, 'supplier a', 'repo1'); // Setup initial lowercase state

    // act
    recordSupplier(map, 'Supplier A', 'repo2');

    // assert
    const data = map.get('supplier a');
    assert.strictEqual(data.display, 'Supplier A');
  });
});

test('parseSuppliersFromMarkdown', async (t) => {
  await t.test('extracts suppliers from Organisational contributions section', () => {
    // arrange
    const mockContent = 'dummy-content';
    const mockMarked = {
      lexer: () => [
        { type: 'heading', depth: 1, text: 'Not this section' },
        { type: 'list', items: [{ text: 'Ignore Me' }] },
        { type: 'heading', depth: 2, text: 'Organisational Contributions' },
        { type: 'list', items: [{ text: 'Supplier A' }, { text: 'Supplier B' }] }
      ]
    };

    // act
    const result = parseSuppliersFromMarkdown(mockContent, mockMarked);

    // assert
    assert.deepStrictEqual(result, ['Supplier A', 'Supplier B']);
  });

  await t.test('handles complex tokens like links', () => {
    // arrange
    const mockContent = 'dummy-content';
    const mockMarked = {
      lexer: () => [
        { type: 'heading', depth: 2, text: 'Organisational contributions' },
        {
          type: 'list',
          items: [
            { tokens: [{ type: 'link', tokens: [{ type: 'text', text: 'Linked Supplier' }] }] }
          ]
        }
      ]
    };

    // act
    const result = parseSuppliersFromMarkdown(mockContent, mockMarked);

    // assert
    assert.deepStrictEqual(result, ['Linked Supplier']);
  });
});

test('isOrgContributionSection', async (t) => {
  await t.test('returns true when matching heading is found', () => {
    // arrange
    const token = { type: 'heading', depth: 2, text: 'Organisational Contributions' };
    
    // act
    const result = isOrgContributionSection(token, false);
    
    // assert
    assert.strictEqual(result, true);
  });

  await t.test('returns false when different heading is found', () => {
    // arrange
    const token = { type: 'heading', depth: 2, text: 'Other Header' };
    
    // act
    const result = isOrgContributionSection(token, true);
    
    // assert
    assert.strictEqual(result, false);
  });

  await t.test('returns current state for non-heading tokens', () => {
    // arrange
    const token = { type: 'paragraph', text: 'Some text' };
    
    // act
    const result = isOrgContributionSection(token, true);
    
    // assert
    assert.strictEqual(result, true);
  });
});

test('extractSuppliersFromList', async (t) => {
  await t.test('extracts and trims supplier names ignoring blanks', () => {
    // arrange
    const items = [
      { text: 'Supplier 1 ' },
      { text: '  ' }, // Blank, should be ignored
      { tokens: [{ type: 'text', text: ' Supplier 2' }] }
    ];

    // act
    const result = extractSuppliersFromList(items);

    // assert
    assert.deepStrictEqual(result, ['Supplier 1', 'Supplier 2']);
  });
});

test('fetchAcknowledgements', async (t) => {
  await t.test('returns content and filename if file exists', async () => {
    // arrange
    const base64Content = Buffer.from('mock markdown content').toString('base64');
    const mockGithub = {
      rest: {
        repos: {
          getContent: async ({ path }) => {
            if (path === 'ACKNOWLEDGEMENTS.md') {
              return { data: { content: base64Content } };
            }
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
        }
      }
    };

    // act
    const result = await fetchAcknowledgements(mockGithub, 'org', 'repo');

    // assert
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.filename, 'ACKNOWLEDGEMENTS.md');
    assert.strictEqual(result.content, 'mock markdown content');
  });

  await t.test('returns null if file does not exist', async () => {
    // arrange
    const mockGithub = {
      rest: {
        repos: {
          getContent: async () => {
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
        }
      }
    };

    // act
    const result = await fetchAcknowledgements(mockGithub, 'org', 'repo');

    // assert
    assert.strictEqual(result, null);
  });

  await t.test('ignores files with no content payload', async () => {
    // arrange
    const mockGithub = {
      rest: {
        repos: {
          getContent: async ({ path }) => {
            if (path === 'ACKNOWLEDGEMENTS.md') {
              return { data: { content: null } }; // Simulates missing content property
            }
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
        }
      }
    };

    // act
    const result = await fetchAcknowledgements(mockGithub, 'org', 'repo');

    // assert
    assert.strictEqual(result, null);
  });

  await t.test('continues when files are not found (catch block coverage)', async () => {
    // arrange
    const mockGithub = {
      rest: {
        repos: {
          getContent: async () => {
            // By throwing, we force the function to land in the catch block 
            // and trigger the `continue` statement on line ~134
            const err = new Error('Not found');
            err.status = 404;
            throw err;
          }
        }
      }
    };

    // act
    const result = await fetchAcknowledgements(mockGithub, 'org', 'repo');

    // assert
    assert.strictEqual(result, null);
  });

  await t.test('throws error if status is not 404', async () => {
    // arrange
    const mockGithub = {
      rest: {
        repos: {
          getContent: async () => {
            const err = new Error('Server Error');
            err.status = 500;
            throw err;
          }
        }
      }
    };

    // act & assert
    await assert.rejects(
      fetchAcknowledgements(mockGithub, 'org', 'repo'),
      { message: 'Server Error', status: 500 }
    );
  });
});

test('setupOctokit', async (t) => {
  await t.test('configures Octokit with throttle plugin and handles rate limit callbacks', () => {
    // arrange
    let capturedOptions;
    const coreLogs = [];
    const mockCore = {
      warning: (m) => coreLogs.push(m),
      info: (m) => coreLogs.push(m)
    };
    const mockGithub = {
      constructor: {
        plugin: () => function MockOctokit(options) {
          capturedOptions = options;
          return {};
        }
      }
    };

    // act
    setupOctokit(mockGithub, mockCore);

    const { onRateLimit, onSecondaryRateLimit } = capturedOptions.throttle;
    const reqOptions = { method: 'GET', url: '/test' };

    const retry1 = onRateLimit(10, reqOptions, null, 0);
    const retry2 = onRateLimit(10, reqOptions, null, 1);
    const retry3 = onSecondaryRateLimit(20, reqOptions, null);

    // assert
    assert.strictEqual(retry1, true);
    assert.strictEqual(retry2, undefined);
    assert.strictEqual(retry3, true);

    const logsStr = coreLogs.join('|');
    assert.ok(logsStr.includes('[Rate Limit] Request quota exhausted'));
    assert.ok(logsStr.includes('Retrying after 10 seconds!'));
    assert.ok(logsStr.includes('[Secondary Rate Limit] Limit detected'));
  });
});

test('detectDuplicates', async (t) => {
  await t.test('identifies matching prefixed suppliers', () => {
    // arrange
    const sortedSuppliers = [
      { display: 'Answer Digital', repos: [] },
      { display: 'Answer Digital Ltd', repos: [] },
      { display: 'Different', repos: [] }
    ];
    
    // act
    const duplicates = detectDuplicates(sortedSuppliers);
    
    // assert
    assert.strictEqual(duplicates.length, 1);
    assert.strictEqual(duplicates[0].current, 'Answer Digital');
    assert.strictEqual(duplicates[0].next, 'Answer Digital Ltd');
  });

  await t.test('ignores small overlaps under length of 4', () => {
    // arrange
    const sortedSuppliers = [
      { display: 'A', repos: [] },
      { display: 'AB', repos: [] }
    ];
    
    // act
    const duplicates = detectDuplicates(sortedSuppliers);
    
    // assert
    assert.strictEqual(duplicates.length, 0);
  });
});

test('writeSupplierRegister', async (t) => {
  const fs = require('fs');
  const path = require('path');

  await t.test('fails securely if template is missing', () => {
    // arrange
    let failedMsg = '';
    const mockFs = { existsSync: () => false };
    const mockCore = { setFailed: (msg) => { failedMsg = msg; } };
    
    // act
    const result = writeSupplierRegister(mockFs, path, mockCore, [], 'profile/ndtp-suppliers-register.md');
    
    // assert
    assert.strictEqual(result, null);
    assert.ok(failedMsg.includes('Template file not found'));
  });

  await t.test('creates directory and writes new file', () => {
    // arrange
    let mkdirCalled = false;
    let writtenPath = '', writtenContent = '';
    const coreLogs = [];
    
    const mockFs = {
      existsSync: (p) => p.includes('register-template.md'), // true for template, false for output
      readFileSync: () => '<!-- SUPPLIER_LIST_PLACEHOLDER -->',
      mkdirSync: () => { mkdirCalled = true; },
      writeFileSync: (p, c) => { writtenPath = p; writtenContent = c; }
    };
    const mockCore = { info: (m) => coreLogs.push(m) };
    const suppliers = [{ display: 'Supplier A' }];
    
    // act
    const result = writeSupplierRegister(mockFs, path, mockCore, suppliers, 'profile/ndtp-suppliers-register.md');
    
    // assert
    assert.strictEqual(result, 'was Created 🆕');
    assert.strictEqual(mkdirCalled, true);
    assert.ok(writtenPath.includes('ndtp-suppliers-register.md'));
    assert.strictEqual(writtenContent.trim(), '- Supplier A');
  });

  await t.test('skips write if no changes', () => {
    // arrange
    let writeCalled = false;
    const mockFs = {
      existsSync: () => true, // Output exists
      readFileSync: (p) => p.includes('register-template.md') ? '<!-- SUPPLIER_LIST_PLACEHOLDER -->' : '- Supplier A',
      writeFileSync: () => { writeCalled = true; }
    };
    const mockCore = { info: () => {} };
    const suppliers = [{ display: 'Supplier A' }];
    
    // act
    const result = writeSupplierRegister(mockFs, path, mockCore, suppliers, 'profile/ndtp-suppliers-register.md');
    
    // assert
    assert.strictEqual(result, 'had No Change ➖');
    assert.strictEqual(writeCalled, false);
  });
});

test('generateJobSummary', async (t) => {
  await t.test('outputs comprehensive summary', async () => {
    // arrange
    const summaryLogs = [];
    const mockCore = {
      summary: {
        addRaw: (m) => summaryLogs.push(m),
        write: async () => {}
      }
    };
    const stats = {
      sortedSuppliers: [{ display: 'Sup', repos: ['repo1'] }],
      totalReposCount: 10,
      reposWithAckCount: 5,
      ackVariantsCount: { 'ACKNOWLEDGEMENTS.md': 5 },
      skippedRepos: [['skipped-repo', 'Archived']],
      potentialDuplicates: [{ current: 'Sup', next: 'Sup Ltd' }],
      fileStatus: 'was Created 🆕'
    };
    
    // act
    await generateJobSummary(mockCore, 'org', stats);
    
    // assert
    const fullSummary = summaryLogs.join('\\n');
    assert.ok(fullSummary.includes('Total Unique Suppliers'));
    assert.ok(fullSummary.includes('ACKNOWLEDGEMENTS.md`: 5'));
    assert.ok(fullSummary.includes('skipped-repo'));
    assert.ok(fullSummary.includes('Sup Ltd'));
    assert.ok(fullSummary.includes('repo1'));
  });
});

test('main execution', async (t) => {
  const fs = require('fs');

  await t.test('end-to-end execution generates updated file and logs correctly', async () => {
    // arrange
    let mkdirCalled = false;
    const writtenFiles = {};
    const coreLogs = [];
    const summaryLogs = [];

    t.mock.method(fs, 'readFileSync', (filePath, _encoding) => {
      if (filePath.includes('register-template.md')) return '# Title\n<!-- SUPPLIER_LIST_PLACEHOLDER -->';
      if (filePath.includes('ndtp-suppliers-register.md')) return 'different content'; // Simulating an existing file with different content to trigger a write
      return '';
    });

    t.mock.method(fs, 'writeFileSync', (filePath, content) => {
      writtenFiles[filePath] = content;
    });

    t.mock.method(fs, 'existsSync', (filePath) => {
      if (filePath.includes('register-template.md')) return true;
      if (filePath.includes('ndtp-suppliers-register.md')) return true;
      if (filePath.includes('profile')) return false;
      return true;
    });

    t.mock.method(fs, 'mkdirSync', () => { mkdirCalled = true; });

    const mockGithub = {
      constructor: {
        plugin: () => {
          return function MockOctokit() {
            return {
              paginate: mockGithub.paginate,
              rest: mockGithub.rest
            };
          };
        }
      },
      paginate: async () => [
        { name: 'repo-with-ack', archived: false },
        { name: 'archived-repo', archived: true },
        { name: '.github', archived: false }, // Excluded via setup logic in main script
        { name: 'missing-ack', archived: false },
        { name: 'repo-with-api-error', archived: false }
      ],
      rest: {
        repos: {
          listForOrg: {},
          getContent: async ({ path, repo }) => {
            if (repo === 'repo-with-api-error') {
              const errApi = new Error('Rate limit exceeded');
              errApi.status = 403;
              throw errApi;
            }
            if (repo === 'missing-ack') {
              const errMissing = new Error('Not found');
              errMissing.status = 404;
              throw errMissing; // Forces the function to skip to the next repo without content
            }
            if (path === 'ACKNOWLEDGEMENTS.md') {
              return { data: { content: Buffer.from('mocked').toString('base64') } };
            }
            const errDefault = new Error('Not found');
            errDefault.status = 404;
            throw errDefault;
          }
        }
      }
    };
    const mockContext = { repo: { owner: 'National-Digital-Twin' } };
    const mockCore = {
      info: (m) => coreLogs.push(m),
      warning: (m) => coreLogs.push(`WARNING: ${m}`),
      setFailed: (m) => coreLogs.push(`FAILED: ${m}`),
      summary: {
        addRaw: (m) => summaryLogs.push(m),
        write: async () => { }
      }
    };
    const mockMarked = {
      lexer: () => [
        { type: 'heading', depth: 2, text: 'Organisational Contributions' },
        { type: 'list', items: [{ text: 'Answer Digital' }, { text: 'Answer Digital Ltd' }] }
      ]
    };

    const main = require('./generate-register.js'); // Main default export

    // act
    await main({ github: mockGithub, context: mockContext, core: mockCore, marked: mockMarked });

    // assert
    assert.strictEqual(mkdirCalled, true);

    // Validates the file logic correctly outputs content
    const writePaths = Object.keys(writtenFiles);
    assert.strictEqual(writePaths.length, 1);
    assert.ok(writePaths[0].includes('ndtp-suppliers-register.md'));

    const writtenContent = writtenFiles[writePaths[0]];
    assert.ok(writtenContent.includes('- Answer Digital'));
    assert.ok(writtenContent.includes('- Answer Digital Ltd'));

    // Validates edge cases like potential duplicates and skipped repos
    const summaryOutput = summaryLogs.join('\n');
    assert.ok(summaryOutput.includes('Skipped Repositories'));
    assert.ok(summaryOutput.includes('Archived'));
    assert.ok(summaryOutput.includes('Excluded'));
    assert.ok(summaryOutput.includes('API Error: Rate limit exceeded'));
    assert.ok(summaryOutput.includes('Potential Duplicates Detected'));
    assert.ok(summaryOutput.includes('was Updated')); // Reaches updating status string mapping 
  });

  await t.test('skips write if no changes detected', async () => {
    // arrange
    let writeCalled = false;

    t.mock.method(fs, 'readFileSync', (filePath) => {
      if (filePath.includes('register-template.md')) return '<!-- SUPPLIER_LIST_PLACEHOLDER -->';
      if (filePath.includes('ndtp-suppliers-register.md')) return '- Only Supplier'; // Matches expected output to trigger a logical skip
      return '';
    });
    t.mock.method(fs, 'writeFileSync', () => { writeCalled = true; });
    t.mock.method(fs, 'existsSync', () => true);
    t.mock.method(fs, 'mkdirSync', () => { });

    const mockGithub = {
      constructor: {
        plugin: () => {
          return function MockOctokit() {
            return {
              paginate: mockGithub.paginate,
              rest: mockGithub.rest
            };
          };
        }
      },
      paginate: async () => [{ name: 'test', archived: false }],
      rest: {
        repos: {
          listForOrg: {},
          getContent: async () => ({ data: { content: Buffer.from('mocked').toString('base64') } }) // Valid format
        }
      }
    };

    // Hardcode marked lexer to always return the single supplier
    const mockMarked = {
      lexer: () => [
        { type: 'heading', depth: 2, text: 'Organisational Contributions' },
        { type: 'list', items: [{ text: 'Only Supplier' }] }
      ]
    };

    const summaryLogs = [];
    const mockCore = {
      info: () => { },
      summary: { addRaw: (m) => summaryLogs.push(m), write: async () => { } }
    };
    const main = require('./generate-register.js');

    // act
    await main({ github: mockGithub, context: { repo: { owner: 'test' } }, core: mockCore, marked: mockMarked });

    // assert
    assert.strictEqual(writeCalled, false, 'Should have skipped writing the file');
    assert.ok(summaryLogs.join('\n').includes('had No Change'), 'Logs should reflect no change');
  });

  await t.test('handles missing template file gracefully', async () => {
    // arrange
    t.mock.method(fs, 'existsSync', () => false); // Enforce failing the template check

    const coreLogs = [];
    const mockCore = {
      setFailed: (msg) => coreLogs.push(`FAILED: ${msg}`),
      info: () => { }
    };
    const mockGithub = {
      constructor: {
        plugin: () => {
          return function MockOctokit() {
            return {
              paginate: mockGithub.paginate,
              rest: mockGithub.rest
            };
          };
        }
      },
      rest: { repos: { listForOrg: {} } },
      paginate: async () => []
    };
    const mockContext = { repo: { owner: 'test' } };
    const main = require('./generate-register.js');

    // act
    await main({ github: mockGithub, context: mockContext, core: mockCore, marked: {} });

    // assert
    assert.ok(coreLogs[0].includes('Template file not found'));
  });
});
