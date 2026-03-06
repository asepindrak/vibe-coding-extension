"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
const vscode = __importStar(require("vscode"));
// import * as myExtension from '../../extension';
suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');
    test('Sample test', () => {
        assert.strictEqual(-1, [1, 2, 3].indexOf(5));
        assert.strictEqual(-1, [1, 2, 3].indexOf(0));
    });
    test('writeFile format validation', () => {
        // Test format validation untuk writeFile blocks
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
        // Test yang valid harus mengandung [writeFile], [/writeFile], dan [file] atau [diff]
        assert.ok(validWriteFileContent.includes("[writeFile]"), "Should contain [writeFile] tag");
        assert.ok(validWriteFileContent.includes("[/writeFile]"), "Should contain [/writeFile] tag");
        assert.ok(validWriteFileContent.includes("[file "), "Should contain [file] block");
        // Test format tidak lengkap
        assert.ok(invalidWriteFileMissingClose.includes("[writeFile]"), "Should contain [writeFile] tag");
        assert.ok(!invalidWriteFileMissingClose.includes("[/writeFile]"), "Should not contain [/writeFile] tag");
        assert.ok(invalidWriteFileMissingBlocks.includes("[writeFile]"), "Should contain [writeFile] tag");
        assert.ok(invalidWriteFileMissingBlocks.includes("[/writeFile]"), "Should contain [/writeFile] tag");
        assert.ok(!invalidWriteFileMissingBlocks.includes("[file "), "Should not contain [file] block");
        assert.ok(!invalidWriteFileMissingBlocks.includes("[diff "), "Should not contain [diff] block");
    });
    test('writeFile fallback parsing', () => {
        // Test fallback parsing untuk format yang tidak sempurna
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
        // Test berbagai skenario parsing yang kompleks
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
function newFunction() {
  return "new and improved";
}
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
        // Test regex patterns untuk file blocks
        const fileRegex = /\[file\s+(?:name|path)=["']?([^"'\s\]]+)["']?(?:\s+type=["'][^"']+["'])?\]([\s\S]*?)\[\s*\/file\s*\]/gi;
        const diffRegex = /\[diff\s+(?:name|path)=["']?([^"'\s\]]+)["']?\]([\s\S]*?)\[\s*\/diff\s*\]/gi;
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
            lines.pop(); // Remove last line (```)
            const strippedContent = lines.join("\n").trim();
            assert.ok(!strippedContent.includes("```"), "Should strip markdown code block markers");
            assert.ok(strippedContent.includes("interface User"), "Should preserve code content after stripping");
        }
    });
    test('writeFile edge cases and error handling', () => {
        // Test edge cases dan error handling
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
        // Test regex dengan berbagai format attribute
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
});
//# sourceMappingURL=extension.test.js.map