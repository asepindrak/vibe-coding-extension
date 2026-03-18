import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
	createSearchResultPreview,
	formatRankedSymbolResults,
	formatSymbolKind,
	parseSearchQuery,
	rankSearchMatch,
	rankSymbolMatch,
	shouldRejectSearchQuery,
} from '../codeSearch';
import { acceptInlineDiffHunk, computeInlineDiffHunks, rejectInlineDiffHunk } from '../inlineDiff';
import { getCompletionState } from '../workflowCompletion';
import { createDiffBlockRegex, createFileBlockRegex, extractFileBlocks, extractWriteTargets } from '../writePayload';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('completion state gates shortcuts during pending recovery', () => {
		assert.deepStrictEqual(
			getCompletionState({
				recoveryPending: true,
				recoveryStepExecuted: false,
				verificationOnlyPlan: false,
				hadStepError: false,
				autoFixTriggered: false,
			}),
			{
				recoverySatisfied: false,
				canUseCompletionShortcut: false,
			},
		);

		assert.deepStrictEqual(
			getCompletionState({
				recoveryPending: true,
				recoveryStepExecuted: true,
				verificationOnlyPlan: false,
				hadStepError: false,
				autoFixTriggered: false,
			}),
			{
				recoverySatisfied: true,
				canUseCompletionShortcut: true,
			},
		);

		assert.deepStrictEqual(
			getCompletionState({
				recoveryPending: true,
				recoveryStepExecuted: false,
				verificationOnlyPlan: true,
				hadStepError: false,
				autoFixTriggered: false,
			}),
			{
				recoverySatisfied: true,
				canUseCompletionShortcut: true,
			},
		);
	});

	test('search query parsing falls back safely for invalid regex', () => {
		const parsed = parseSearchQuery('re:foo[');
		assert.strictEqual(parsed.mode, 'literal');
		assert.ok(parsed.warnings[0].includes('Invalid regex'));
		assert.ok(parsed.regex.test('foo['));
		assert.ok(!parsed.regex.test('foo1'));
	});

	test('search query parsing supports slash regex and literal mode', () => {
		const regexParsed = parseSearchQuery('/use[A-Z]\\w+/');
		assert.strictEqual(regexParsed.mode, 'regex');
		assert.ok(regexParsed.regex.test('useDeferredValue'));

		const literalParsed = parseSearchQuery('literal:useState(');
		assert.strictEqual(literalParsed.mode, 'literal');
		assert.ok(literalParsed.regex.test('const x = useState('));
		assert.ok(!literalParsed.regex.test('const x = useStateValue'));
	});

	test('search query rejection only applies to short literal searches', () => {
		assert.strictEqual(shouldRejectSearchQuery(parseSearchQuery('ab')), true);
		assert.strictEqual(shouldRejectSearchQuery(parseSearchQuery('re:^id$')), false);
	});

	test('search ranking prioritizes likely symbol definitions', () => {
		const definitionScore = rankSearchMatch({
			relativePath: 'src/hooks/useThing.ts',
			lineNum: 12,
			line: 'export function useThing() {',
			normalizedQuery: 'useThing',
		});
		const usageScore = rankSearchMatch({
			relativePath: 'src/components/App.tsx',
			lineNum: 220,
			line: 'const value = useThing();',
			normalizedQuery: 'useThing',
		});

		assert.ok(definitionScore > usageScore);
		assert.strictEqual(
			createSearchResultPreview('   export function useThing() {   '),
			'export function useThing() {',
		);
	});

	test('symbol ranking prioritizes exact definitions and formats output', () => {
		const exactScore = rankSymbolMatch({
			symbolName: 'useThing',
			symbolKind: 'Function',
			relativePath: 'src/hooks/useThing.ts',
			lineNum: 8,
			normalizedQuery: 'useThing',
		});
		const partialScore = rankSymbolMatch({
			symbolName: 'useThingValue',
			symbolKind: 'Variable',
			relativePath: 'src/components/App.tsx',
			lineNum: 180,
			normalizedQuery: 'useThing',
		});

		assert.ok(exactScore > partialScore);
		assert.strictEqual(formatSymbolKind(11), 'Function');
		assert.deepStrictEqual(
			formatRankedSymbolResults([
				{
					name: 'useThing',
					kind: 'Function',
					relativePath: 'src/hooks/useThing.ts',
					lineNum: 8,
					score: exactScore,
				},
			]),
			['src/hooks/useThing.ts:8: [Function] useThing'],
		);
	});

	test('writeFile format validation', () => {
		// Test format validation for writeFile blocks
		const validWriteFileContent = `[writeFile]
[file name="test.js"]
console.log("Hello World");
[/file]
[/writeFile]`;

		const invalidWriteFileMissingClose = `[writeFile]
[file name="test.js"]
console.log("Hello World");
[/file]`;

		const invalidWriteFileMissingBlocks = `[writeFile]
console.log("Hello World");
[/writeFile]`;

		// Valid tests must contain [writeFile], [/writeFile], and [file] or [diff]
		assert.ok(validWriteFileContent.includes("[writeFile]"), "Should contain [writeFile] tag");
		assert.ok(validWriteFileContent.includes("[/writeFile]"), "Should contain [/writeFile] tag");
		assert.ok(validWriteFileContent.includes("[file "), "Should contain [file] block");

		// Test incomplete format
		assert.ok(invalidWriteFileMissingClose.includes("[writeFile]"), "Should contain [writeFile] tag");
		assert.ok(!invalidWriteFileMissingClose.includes("[/writeFile]"), "Should not contain [/writeFile] tag");

		assert.ok(invalidWriteFileMissingBlocks.includes("[writeFile]"), "Should contain [writeFile] tag");
		assert.ok(invalidWriteFileMissingBlocks.includes("[/writeFile]"), "Should contain [/writeFile] tag");
		assert.ok(!invalidWriteFileMissingBlocks.includes("[file "), "Should not contain [file] block");
		assert.ok(!invalidWriteFileMissingBlocks.includes("[diff "), "Should not contain [diff] block");
	});

	test('writeFile fallback parsing', () => {
		// Test fallback parsing for imperfect format
		const openWriteFileTag = `[writeFile]
[file name="test.js"]
console.log("Hello World");
`;

		const fileBlockWithoutWrapper = `[file name="test.js"]
console.log("Hello World");
[/file]`;

		const markdownCodeBlock = "```javascript\nconsole.log(\"Hello World\");\n```";

		// Test fallback strategies
		const writeFileOpenMatch = openWriteFileTag.match(/\[writeFile\s*\]([\s\S]*?)(?:\[\/writeFile\s*\]|$)/i);
		assert.ok(writeFileOpenMatch, "Should match open [writeFile] tag");
		assert.ok(writeFileOpenMatch[1].includes("[file"), "Should capture content after [writeFile]");

		const hasFileBlocks = /\[file\s+/i.test(fileBlockWithoutWrapper);
		assert.ok(hasFileBlocks, "Should detect [file] blocks without wrapper");

		const codeBlockMatch = markdownCodeBlock.match(/```[\s\S]*?\n([\s\S]*?)```/);
		assert.ok(codeBlockMatch, "Should match markdown code block");
		assert.ok(codeBlockMatch[1].includes("console.log"), "Should extract code content");
	});

	test('writeFile comprehensive parsing scenarios', () => {
		// Test various complex parsing scenarios

		// 1. Multiple file blocks
		const multipleFilesContent = `[writeFile]
[file name="app.js"]
const app = require('express')();
app.get('/', (req, res) => res.send('Hello'));
app.listen(3000);
[/file]

[file name="package.json"]
{
  "name": "test-app",
  "version": "1.0.0",
  "dependencies": {
    "express": "^4.18.0"
  }
}
[/file]
[/writeFile]`;

		// 2. Diff blocks
		const diffContent = `[writeFile]
[diff name="utils.js"]
<<<<<<< SEARCH
function oldFunction() {
  return "old";
}
=======
function newFunction() {
  return "new and improved";
}
>>>>>>> REPLACE
[/diff]
[/writeFile]`;

		// 3. Mixed file and diff blocks
		const mixedContent = `[writeFile]
[file name="newfile.txt"]
This is a new file
[/file]

[diff name="existing.js"]
console.log("new");
[/diff]
[/writeFile]`;

		// 4. Markdown code blocks (should be stripped)
		const markdownContent = `[writeFile]
[file name="test.ts"]
\`\`\`typescript
interface User {
  name: string;
  age: number;
}

const user: User = { name: "John", age: 30 };
\`\`\`
[/file]
[/writeFile]`;

		// Test regex patterns for file blocks
		const fileRegex = createFileBlockRegex();
		const diffRegex = createDiffBlockRegex();

		// Test multiple files
		const fileMatches = [...multipleFilesContent.matchAll(fileRegex)];
		assert.strictEqual(fileMatches.length, 2, "Should find 2 file blocks");
		assert.strictEqual(fileMatches[0][1], "app.js", "First file should be app.js");
		assert.strictEqual(fileMatches[1][1], "package.json", "Second file should be package.json");

		// Test diff blocks
		const diffMatches = [...diffContent.matchAll(diffRegex)];
		assert.strictEqual(diffMatches.length, 1, "Should find 1 diff block");
		assert.strictEqual(diffMatches[0][1], "utils.js", "Diff should be for utils.js");
		assert.ok(diffMatches[0][2].includes("<<<<<<< SEARCH"), "Should contain search marker");
		assert.ok(diffMatches[0][2].includes(">>>>>>> REPLACE"), "Should contain replace marker");

		// Test mixed content
		const mixedFileMatches = [...mixedContent.matchAll(fileRegex)];
		const mixedDiffMatches = [...mixedContent.matchAll(diffRegex)];
		assert.strictEqual(mixedFileMatches.length, 1, "Should find 1 file block in mixed content");
		assert.strictEqual(mixedDiffMatches.length, 1, "Should find 1 diff block in mixed content");

		const mixedTargets = extractWriteTargets(mixedContent);
		assert.strictEqual(mixedTargets.length, 2, "Should track both file and diff targets");
		assert.deepStrictEqual(mixedTargets.map((m) => m.path), ["newfile.txt", "existing.js"], "Should preserve write target order");
		assert.deepStrictEqual(mixedTargets.map((m) => m.kind), ["file", "diff"], "Should preserve write target kinds");

		const fileBlocks = extractFileBlocks(multipleFilesContent);
		assert.strictEqual(fileBlocks.length, 2, "Should extract two file blocks via helper");
		assert.strictEqual(fileBlocks[0].path, "app.js", "First file block path should match");
		assert.ok(fileBlocks[1].content.includes('"express"'), "Second file block content should be preserved");

		// Test markdown stripping
		const markdownFileMatches = [...markdownContent.matchAll(fileRegex)];
		assert.strictEqual(markdownFileMatches.length, 1, "Should find 1 file block in markdown content");
		const fileContent = markdownFileMatches[0][2];
		assert.ok(fileContent.includes("interface User"), "Should contain TypeScript interface");
		assert.ok(fileContent.includes("const user"), "Should contain variable declaration");

		// Test stripping markdown code blocks
		if (fileContent.startsWith("```") && fileContent.endsWith("```")) {
			const lines = fileContent.split("\n");
			lines.shift(); // Remove first line (```language)
			lines.pop();   // Remove last line (```)
			const strippedContent = lines.join("\n").trim();
			assert.ok(!strippedContent.includes("```"), "Should strip markdown code block markers");
			assert.ok(strippedContent.includes("interface User"), "Should preserve code content after stripping");
		}
	});

	test('writeFile edge cases and error handling', () => {
		// Test edge cases and error handling

		// 1. Empty content
		const emptyContent = `[writeFile]
[/writeFile]`;
		assert.ok(emptyContent.includes("[writeFile]"), "Should contain writeFile tags");
		assert.ok(!emptyContent.includes("[file "), "Should not contain file blocks");
		assert.ok(!emptyContent.includes("[diff "), "Should not contain diff blocks");

		// 2. Malformed tags
		const malformedTags = `[writeFile]
[file name="test.js"]
content
[/file name="test.js"]
[/writeFile]`;
		assert.ok(malformedTags.includes("[writeFile]"), "Should contain writeFile tags");

		// 3. Missing quotes in attributes
		const missingQuotes = `[writeFile]
[file name=test.js]
content
[/file]
[/writeFile]`;
		assert.ok(missingQuotes.includes("[writeFile]"), "Should contain writeFile tags");

		// 4. Nested writeFile tags (should not be valid)
		const nestedWriteFile = `[writeFile]
[file name="outer.js"]
[writeFile]
[file name="inner.js"]
inner content
[/file]
[/writeFile]
outer content
[/file]
[/writeFile]`;
		assert.ok(nestedWriteFile.includes("[writeFile]"), "Should contain writeFile tags");

		// 5. Very large content
		const largeContent = `[writeFile]
[file name="large.js"]
${'console.log("test");\n'.repeat(1000)}
[/file]
[/writeFile]`;
		assert.ok(largeContent.includes("[writeFile]"), "Should handle large content");
		assert.ok(largeContent.length > 10000, "Should be large content");

		// Test regex with various attribute formats
		const flexibleAttributeRegex = /\[file\s+(?:name|path)=["']?([^"'\s\]]+)["']?(?:\s+type=["'][^"']+["'])?\]([\s\S]*?)\[\s*\/file\s*\]/gi;

		// Should match various attribute formats
		const testCases = [
			`[file name="test.js"]content[/file]`,
			`[file path="test.js"]content[/file]`,
			`[file name='test.js']content[/file]`,
			`[file name=test.js]content[/file]`,
			`[file name="test.js" type="text/javascript"]content[/file]`
		];

		testCases.forEach((testCase, index) => {
			const matches = [...testCase.matchAll(flexibleAttributeRegex)];
			assert.strictEqual(matches.length, 1, `Test case ${index + 1} should match: ${testCase}`);
			assert.strictEqual(matches[0][1], "test.js", `Test case ${index + 1} should extract filename`);
		});
	});

	test('inline diff hunks classify add modify and delete changes', () => {
		assert.deepStrictEqual(
			computeInlineDiffHunks('const a = 1;\nconst b = 2;', 'const a = 1;\nconst b = 3;'),
			[
				{
					kind: 'modify',
					originalStart: 1,
					originalEnd: 2,
					modifiedStart: 1,
					modifiedEnd: 2,
					originalLines: ['const b = 2;'],
					modifiedLines: ['const b = 3;'],
				},
			],
		);

		assert.deepStrictEqual(
			computeInlineDiffHunks('const a = 1;', 'const a = 1;\nconst b = 2;'),
			[
				{
					kind: 'add',
					originalStart: 1,
					originalEnd: 1,
					modifiedStart: 1,
					modifiedEnd: 2,
					originalLines: [],
					modifiedLines: ['const b = 2;'],
				},
			],
		);

		assert.deepStrictEqual(
			computeInlineDiffHunks('const a = 1;\nconst b = 2;', 'const a = 1;'),
			[
				{
					kind: 'delete',
					originalStart: 1,
					originalEnd: 2,
					modifiedStart: 1,
					modifiedEnd: 1,
					originalLines: ['const b = 2;'],
					modifiedLines: [],
				},
			],
		);
	});

	test('inline diff hunks can be accepted or rejected individually', () => {
		const baseline = 'const a = 1;\nconst b = 2;\nconst c = 3;';
		const current = 'const a = 1;\nconst b = 20;\nconst x = 99;\nconst c = 3;';
		const hunks = computeInlineDiffHunks(baseline, current);

		assert.strictEqual(hunks.length, 2);

		const acceptedBaseline = acceptInlineDiffHunk(baseline, current, hunks[0]);
		assert.strictEqual(
			acceptedBaseline,
			'const a = 1;\nconst b = 20;\nconst c = 3;',
		);

		const rejectedCurrent = rejectInlineDiffHunk(baseline, current, hunks[1]);
		assert.strictEqual(
			rejectedCurrent,
			'const a = 1;\nconst b = 20;\nconst c = 3;',
		);
	});
});
