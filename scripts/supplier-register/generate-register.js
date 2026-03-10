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

/**
 * Recursively extracts plain text from an array of marked tokens.
 *
 * @param {Array} tokens - An array of marked tokens (e.g., text, strong, em, link).
 * @returns {string} The concatenated plain text extracted from the tokens.
 */
const extractTextFromTokens = (tokens) => {
  if (!tokens) return '';
  let result = '';
  for (const t of tokens) {
    if (t.type === 'link') {
      // If it's a link, we only want its inner text
      result += extractTextFromTokens(t.tokens);
    } else if (t.type === 'text' || t.type === 'escape' || t.type === 'strong' || t.type === 'em') {
      // For formatting elements or plain text, append the literal text or crawl deeper
      if (t.tokens) {
        result += extractTextFromTokens(t.tokens);
      } else {
        result += t.text;
      }
    } else if (t.tokens) {
      result += extractTextFromTokens(t.tokens);
    }
  }
  return result;
};

/**
 * Adds or updates a supplier entry in the provided {@link supplierReposMap}, tracking repositories.
 * 
 * @param {Map<string, Object>} supplierReposMap - Map storing supplier data with lowercase display names as keys.
 * @param {string} entry - The supplier display name found in the acknowledgements file.
 * @param {string} repoName - The repository name where the supplier was acknowledged.
 */
const recordSupplier = (supplierReposMap, entry, repoName) => {
  const key = entry.toLowerCase();
  if (supplierReposMap.has(key)) {
    // Prefer capitalised version of the name if a lowercase one is currently stored
    const current = supplierReposMap.get(key).display;
    if (entry.startsWith(entry.charAt(0).toUpperCase()) && !current.startsWith(current.charAt(0).toUpperCase())) {
      supplierReposMap.get(key).display = entry;
    }
  } else {
    supplierReposMap.set(key, { display: entry, repos: [] });
  }

  if (!supplierReposMap.get(key).repos.includes(repoName)) {
    supplierReposMap.get(key).repos.push(repoName);
  }
};

/**
 * Iterates through potential variations of the acknowledgements file to fetch its contents.
 * 
 * Variations iterated over:
 * - ACKNOWLEDGEMENTS.md
 * - Acknowledgements.md
 * - acknowledgements.md
 * 
 * @param {Object} github - The Octokit client instance.
 * @param {string} owner - The GitHub organisation or owner name.
 * @param {string} repo - The GitHub repository name.
 * @returns {Promise<{content: string, filename: string}|null>} The file content and matched filename, or null if not found.
 */
const fetchAcknowledgements = async (github, owner, repo) => {
  const filenames = ["ACKNOWLEDGEMENTS.md", "Acknowledgements.md", "acknowledgements.md"];
  for (const filename of filenames) {
    try {
      const response = await github.rest.repos.getContent({
        owner,
        repo,
        path: filename,
      });
      if (response.data.content) {
        return {
          content: Buffer.from(response.data.content, 'base64').toString('utf-8'),
          filename,
        };
      }
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
      // File not found (404), safely continue to the next filename variant
    }
  }
  return null;
};

/**
 * Parses markdown content and extracts suppliers listed under "Organisational Contributions".
 * 
 * @param {string} content - The raw markdown content to be parsed.
 * @param {Object} marked - The marked library instance used for tokenisation.
 * @returns {string[]} An array of extracted supplier names.
 */
const parseSuppliersFromMarkdown = (content, marked) => {
  const tokens = marked.lexer(content);
  const suppliers = [];
  let inOrgSection = false;

  for (const token of tokens) {
    inOrgSection = isOrgContributionSection(token, inOrgSection);

    if (inOrgSection && token.type === 'list') {
      const extracted = extractSuppliersFromList(token.items);
      suppliers.push(...extracted);
    }
  }
  return suppliers;
};

/**
 * Determines whether iterative scanning of tokens has entered, or remains within, the "Organisational contributions" section.
 * 
 * @param {Object} token - A marked token representing a markdown element.
 * @param {boolean} currentState - The existing presence within the target section.
 * @returns {boolean} True if inside "Organisational contributions", otherwise returns the current state.
 */
const isOrgContributionSection = (token, currentState) => {
  if (token.type === 'heading' && token.depth === 2) {
    return /organisational contributions/i.test(token.text);
  }
  return currentState;
};

/**
 * Maps over list items and normalises output text into an array of strings.
 * 
 * @param {Array} items - An array of list item tokens.
 * @returns {string[]} An array of cleaned supplier string contents.
 */
const extractSuppliersFromList = (items) => {
  const extracted = [];
  for (const item of items) {
    const entry = (item.tokens ? extractTextFromTokens(item.tokens) : item.text).trim();
    if (entry) extracted.push(entry);
  }
  return extracted;
};

/**
 * Initialises a rate-limit aware Octokit instance wrapping existing context methods.
 * 
 * @param {Object} github - The GitHub action context or base octokit instance.
 * @param {Object} core - The @actions/core context for logging warnings/info.
 * @returns {Object} A throttled octokit client.
 */
const setupOctokit = (github, core) => {
  const { throttling } = require('@octokit/plugin-throttling');
  const ThrottledOctokit = github.constructor.plugin(throttling);
  return new ThrottledOctokit({
    throttle: {
      onRateLimit: (retryAfter, options, _octo, retryCount) => {
        core.warning(`[Rate Limit] Request quota exhausted for request ${options.method} ${options.url}`);
        if (retryCount < 1) {
          core.info(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onSecondaryRateLimit: (retryAfter, options, _octo) => {
        core.warning(`[Secondary Rate Limit] Limit detected for request ${options.method} ${options.url}`);
        core.info(`Retrying after ${retryAfter} seconds!`);
        return true;
      },
    }
  });
};

/**
 * Identifies potential duplicate suppliers based on matching string prefixes avoiding short conflicts.
 * 
 * @param {Array<{display: string, repos: string[]}>} sortedSuppliers - A sorted list of registered suppliers.
 * @returns {Array<{current: string, next: string}>} Details outlining possible duplicate collisions.
 */
const detectDuplicates = (sortedSuppliers) => {
  const potentialDuplicates = [];
  for (let i = 0; i < sortedSuppliers.length - 1; i++) {
    const current = sortedSuppliers[i].display.toLowerCase();
    const next = sortedSuppliers[i + 1].display.toLowerCase();

    // Flag if next supplier name starts with current one (e.g., "Answer Digital" vs "Answer Digital Ltd"), to avoid tiny string overlap, require min length of 4
    if (current.length >= 4 && next.startsWith(current) && next !== current) {
      potentialDuplicates.push({ current: sortedSuppliers[i].display, next: sortedSuppliers[i + 1].display });
    }
  }
  return potentialDuplicates;
};

/**
 * Populates the markdown template with extracted suppliers and secures output within the required directory.
 * 
 * @param {Object} fs - The Node.js filesystem module.
 * @param {Object} path - The Node.js path module.
 * @param {Object} core - The GitHub actions core module.
 * @param {Array<{display: string, repos: string[]}>} sortedSuppliers - The aggregated suppliers metadata.
 * @returns {string|null} Descriptive string of file change action (i.e. was Created, was Updated).
 */
const writeSupplierRegister = (fs, path, core, sortedSuppliers, outputPath) => {
  const templatePath = path.join(__dirname, 'register-template.md');
  if (!fs.existsSync(templatePath)) {
    core.setFailed(`Template file not found at ${templatePath}`);
    return null;
  }

  const templateContent = fs.readFileSync(templatePath, 'utf-8');

  let supplierListMarkdown = '';
  for (const supplier of sortedSuppliers) {
    supplierListMarkdown += `- ${supplier.display}\n`;
  }

  const content = templateContent.replace('<!-- SUPPLIER_LIST_PLACEHOLDER -->', supplierListMarkdown.trim());

  const outputDir = path.dirname(outputPath);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let existingContent = '';
  let fileStatus = 'was Created 🆕';
  if (fs.existsSync(outputPath)) {
    existingContent = fs.readFileSync(outputPath, 'utf-8');
    fileStatus = 'was Updated 📝';
  }

  if (existingContent === content) {
    core.info(`No changes detected for ${outputPath}. Skipping file write.`);
    fileStatus = 'had No Change ➖';
  } else {
    fs.writeFileSync(outputPath, content);
    core.info(`Successfully generated and updated ${outputPath}`);
  }

  return fileStatus;
};

/**
 * Outputs a comprehensive job summary illustrating findings to the GitHub workflow run action dashboard.
 * 
 * @param {Object} core - The GitHub actions core module.
 * @param {string} orgName - Target GitHub organisation processed.
 * @param {Object} stats - Collected statistics relating to processing throughput, duplication factors, and results.
 */
const generateJobSummary = async (core, orgName, stats) => {
  const { sortedSuppliers, totalReposCount, reposWithAckCount, ackVariantsCount, skippedRepos, potentialDuplicates, fileStatus } = stats;

  core.summary.addRaw('# Supplier Register Updates 📊\n', true);
  core.summary.addRaw(`The \`ndtp-suppliers-register.md\` ${fileStatus}.\n`, true);
  core.summary.addRaw(`| Metric | Value |
| :--- | :--- |
| Total Unique Suppliers | ${sortedSuppliers.length} |
| Total Public Repositories Scanned | ${totalReposCount} |
| Repositories with Acknowledgements | ${reposWithAckCount} |`, true);

  if (Object.keys(ackVariantsCount).length > 0) {
    const variantsStats = Object.entries(ackVariantsCount)
      .map(([name, count]) => `\`${name}\`: ${count}`)
      .join(', ');
    core.summary.addRaw(`| File Variants Used | ${variantsStats} |\n`, true);
  }

  if (skippedRepos.length > 0) {
    core.summary.addRaw('## 🚫 Skipped Repositories\n', true);
    core.summary.addRaw(`| Repository | Reason |
| :--- | :--- |`, true);
    for (const [repoName, reason] of skippedRepos) {
      core.summary.addRaw(`| [${repoName}](https://github.com/${orgName}/${repoName}) | ${reason} |`, true);
    }
  }

  if (potentialDuplicates.length > 0) {
    core.summary.addRaw('\n## ⚠️ Potential Duplicates Detected\n', true);
    for (const d of potentialDuplicates) {
      core.summary.addRaw(`- \`${d.current}\` and \`${d.next}\``, true);
    }
  }

  core.summary.addRaw('\n## 🏢 Supplier Repository Links\n', true);
  core.summary.addRaw(`| Supplier | Acknowledged Repositories |
| :--- | :--- |`, true);
  for (const supplier of sortedSuppliers) {
    const links = supplier.repos.map(r => `[${r}](https://github.com/${orgName}/${r})`).join(', ');
    core.summary.addRaw(`| ${supplier.display} | ${links} |`, true);
  }
  core.summary.addRaw('\n');

  await core.summary.write();
};

/**
 * Orchestrates fetching repositories, scanning acknowledgements and ultimately building the supplier register context.
 * 
 * @param {Object} params - Orchestrator parameters.
 * @param {Object} params.github - Authenticated octokit object.
 * @param {Object} params.context - Action contextual execution details.
 * @param {Object} params.core - Core GitHub actions toolkit functionality.
 * @param {Object} params.marked - Marked markdown text parsing library.
 * @param {string} [params.outputPath] - Optional path to explicitly write the generated markdown file to.
 */
const main = async ({ github, context, core, marked, outputPath }) => {
  const fs = require('node:fs');
  const path = require('node:path');
  
  const octokit = setupOctokit(github, core);

  const orgName = context.repo.owner;

  // stores Map<lowercase, { display: string, repos: string[] }>
  const supplierReposMap = new Map();
  const ackVariantsCount = {};
  const excludedRepos = ['archetypes', '.github'];
  const excludedReposLower = new Set(excludedRepos.map(r => r.toLowerCase()));
  const skippedRepos = [];

  let totalReposCount = 0;
  let reposWithAckCount = 0;

  core.info(`Fetching repositories for ${orgName}...`);

  // 1. Get all public repositories
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org: orgName,
    type: 'public',
  });

  for (const repo of repos) {
    if (repo.archived) {
      core.info(`Skipping archived repository: ${repo.name}`);
      skippedRepos.push([repo.name, 'Archived']);
      continue;
    }

    if (excludedReposLower.has(repo.name.toLowerCase())) {
      core.info(`Skipping excluded repository: ${repo.name}`);
      skippedRepos.push([repo.name, 'Excluded']);
      continue;
    }

    totalReposCount++;

    core.info(`Processing ${repo.name}...`);

    // 2. Fetch ACKNOWLEDGEMENTS.md content
    let fetched;
    try {
      fetched = await fetchAcknowledgements(octokit, orgName, repo.name);
    } catch (error) {
      core.warning(`API error fetching from ${repo.name}: ${error.message}`);
      skippedRepos.push([repo.name, `API Error: ${error.message}`]);
      continue;
    }

    if (!fetched) {
      core.info(`  No ACKNOWLEDGEMENTS.md found in ${repo.name}.`);
      continue;
    }

    reposWithAckCount++;

    // Increment the count for the specific variant of the acknowledgements file
    const currentVariantCount = ackVariantsCount[fetched.filename] || 0;
    ackVariantsCount[fetched.filename] = currentVariantCount + 1;

    // 3. Parse content with marked
    const suppliers = parseSuppliersFromMarkdown(fetched.content, marked);

    for (const entry of suppliers) {
      recordSupplier(supplierReposMap, entry, repo.name);
      core.info(`  Found: ${entry}`);
    }
  }

  // 4. Sort and deduplicate (case-insensitive deduplication, but preserving display case)
  const sortedSuppliers = Array.from(supplierReposMap.values()).sort((a, b) =>
    a.display.toLowerCase().localeCompare(b.display.toLowerCase())
  );

  const potentialDuplicates = detectDuplicates(sortedSuppliers);

  // 5 & 6. Generate Content and Write to file
  const finalOutputPath = outputPath || path.join('profile', 'ndtp-suppliers-register.md');
  const fileStatus = writeSupplierRegister(fs, path, core, sortedSuppliers, finalOutputPath);
  if (!fileStatus) return; // Exit if template not found

  // 7. Write Job Summary
  await generateJobSummary(core, orgName, {
    sortedSuppliers,
    totalReposCount,
    reposWithAckCount,
    ackVariantsCount,
    skippedRepos,
    potentialDuplicates,
    fileStatus
  });
};

module.exports = Object.assign(main, {
  extractTextFromTokens,
  recordSupplier,
  fetchAcknowledgements,
  parseSuppliersFromMarkdown,
  isOrgContributionSection,
  extractSuppliersFromList,
  setupOctokit,
  detectDuplicates,
  writeSupplierRegister,
  generateJobSummary
});
