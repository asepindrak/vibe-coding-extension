// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';
import * as path from 'path';
import logger from 'vico-logger';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

let lastSuggestion: string | null = null;
let lastLinePrefix: string | null = null;

function debounce(func: (...args: any[]) => void, wait: number) {
	let timeout: NodeJS.Timeout | null;
	return function executedFunction(...args: any[]) {
		const later = () => {
			timeout = null; // Clear timeout
			func(...args); // Execute the function
		};
		if (timeout) {
			clearTimeout(timeout); // Clear the previous timeout
		}
		timeout = setTimeout(later, wait); // Set new timeout
	};
}

function stripPrefix(suggestion: string, linePrefix: string) {
	if (suggestion.startsWith(linePrefix)) {
		return suggestion.slice(linePrefix.length);
	}
	return suggestion;
}

let requestId = 0;
let currentAbortController: AbortController | null = null;
let lastRequestLine: number | null = null;
let lastRequestPrefix: string | null = null;

let lastTypedAt = Date.now();

async function fetchSuggestions(context: vscode.ExtensionContext, editor: vscode.TextEditor) {
	if (!isInlineEnabled()) return;

	currentAbortController?.abort();
	const controller = new AbortController();
	currentAbortController = controller;

	const currentRequest = ++requestId;

	const cursorLine = editor.selection.active.line;

	// 👉 Baris sumber (kalau baris kosong, ambil baris atas)
	let sourceLine = cursorLine;
	let lineText = editor.document.lineAt(cursorLine).text;

	if (!lineText.trim() && cursorLine > 0) {
		sourceLine = cursorLine - 1;
		lineText = editor.document.lineAt(sourceLine).text;
	}

	if (!lineText.trim()) return;

	const cleanedInput = removeCommentTags(lineText.trim());
	if (cleanedInput.length < 3 && cursorLine === sourceLine) return;


	// 👉 Inline muncul di posisi cursor (bisa baris kosong)
	const isNewLine = cursorLine !== sourceLine;

	lastRequestLine = cursorLine;
	lastRequestPrefix = isNewLine ? '' : cleanedInput;
	lastLinePrefix = lineText;

	const token = context.globalState.get('token');
	if (!token) {
		vscode.window.showErrorMessage("Vibe Coding token is missing. Please login first.");
		return;
	}

	// 🔥 Ambil konteks sekitar baris sumber (hemat token + relevan)
	const CONTEXT_RADIUS = 40;
	const contextCenterLine = sourceLine;
	const start = Math.max(0, contextCenterLine - CONTEXT_RADIUS);
	const end = Math.min(editor.document.lineCount - 1, contextCenterLine + CONTEXT_RADIUS);

	let contextCode = '';
	for (let i = start; i <= end; i++) {
		contextCode += editor.document.lineAt(i).text + '\n';
	}

	// Status bar loading
	loadingStatusBarItem.text = "⚡ Vibe Coding thinking...";
	if (isNewLine) {
		loadingStatusBarItem.text = "✨ Vibe Coding predicting next line...";
	}
	const showLoadingTimeout = setTimeout(() => loadingStatusBarItem.show(), 400);

	const lang = editor.document.languageId;
	const file = path.basename(editor.document.fileName);

	const body = {
		userId: 'vscode-user',
		message:
			`File: ${file}\n` +
			`Language: ${lang}\n` +
			`Follow ${lang} best practices and syntax.\n` +
			`Here is the surrounding code context:\n${contextCode}\n\n` +
			(isNewLine
				? `The user just pressed Enter and is starting a new line.\n` +
				`Suggest ONLY the next single line of code that should appear here.\n`
				: `The user is currently typing this line: "${cleanedInput}".\n` +
				`Complete ONLY this line.\n`
			) +
			`Return a SINGLE LINE completion only.\n` +
			`Do NOT add new lines.\n` +
			`Do NOT return multiple statements.\n` +
			`Do NOT repeat any existing text from the current line.\n` +
			`Do NOT add braces, semicolons, or syntax that already exists later in the file.\n` +
			`Return ONLY the continuation text without explanations, markdown, or code fences.`
	};



	// 👉 simpan posisi cursor saat request dikirim
	const requestLine = cursorLine;

	try {
		const response = await fetch('http://103.250.10.249:13100/api/suggest', {
			method: 'POST',
			signal: controller.signal,
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorMessage = await response.text();
			throw new Error(`Error ${response.status}: ${errorMessage}`);
		}

		if (currentRequest !== requestId) return; // ❌ skip response lama

		const suggestions: any = await response.json();

		// ❌ Kalau user pindah baris, skip
		if (editor.selection.active.line !== requestLine) return;

		const freshLine = editor.document.lineAt(requestLine).text;
		presentSuggestions(suggestions.message, freshLine);

		await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
		setTimeout(() => {
			if (lastSuggestion) {
				vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
			}
		}, 50);

	} catch (error) {
		if ((error as any).name === 'AbortError') return;
		console.error('Error while fetching suggestions:', error);
	} finally {
		clearTimeout(showLoadingTimeout);
		loadingStatusBarItem.hide();
	}
}



function isInlineEnabled() {
	return vscode.workspace
		.getConfiguration("vibeCoding")
		.get<boolean>("inline.enabled", true);
}

function normalizeInlineSuggestion(text: string) {
	return text
		.replace(/\n/g, '')
		.replace(/\r/g, '')
		.slice(0, 120);
}

async function presentSuggestions(suggestion: string, linePrefix?: string) {
	console.log("Presenting suggestion:", suggestion);

	if (suggestion && suggestion.trim().length > 0) {
		let next = suggestion;

		if (linePrefix) {
			next = stripPrefix(suggestion, linePrefix);
		}

		lastSuggestion = normalizeInlineSuggestion(next);
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}



async function writeFileVico(context: vscode.ExtensionContext, editor: vscode.TextEditor) {
	logger.info("writeFileVico called");

	const writeContent = context.globalState.get<string>('writeContent');
	if (!writeContent) {
		vscode.window.showWarningMessage('Tidak ada konten untuk ditulis. Belum ada respons dari assistant.');
		return;
	}

	if (!vscode.workspace.workspaceFolders) {
		vscode.window.showErrorMessage('Tidak ada folder workspace terbuka!');
		return;
	}

	const projectRoot = vscode.workspace.workspaceFolders[0].uri;

	try {
		// 1. Extract blok [writeFileVico] ... (jika ada pembungkus)
		const blockMatch = writeContent.match(/\[writeFileVico\]([\s\S]*)/);
		const contentBlock = blockMatch ? blockMatch[1].trim() : writeContent.trim();

		// 2. Parse `name` dari baris pertama
		const nameMatch = contentBlock.match(/name:\s*(.+)/);
		const folderName = nameMatch ? nameMatch[1].trim() : 'generated';
		const actionDir = vscode.Uri.joinPath(projectRoot, 'src', 'actions');
		const pageDir = vscode.Uri.joinPath(projectRoot, 'src', 'page', folderName);
		const typesDir = vscode.Uri.joinPath(projectRoot, 'src', 'types');
		const validationsDir = vscode.Uri.joinPath(projectRoot, 'src', 'validations');

		// 3. Buat folder jika belum ada
		await vscode.workspace.fs.createDirectory(actionDir);
		await vscode.workspace.fs.createDirectory(pageDir);
		await vscode.workspace.fs.createDirectory(typesDir);
		await vscode.workspace.fs.createDirectory(validationsDir);
		logger.info(`Folder ditargetkan: ${actionDir.path}`);
		logger.info(`Folder ditargetkan: ${pageDir.path}`);
		logger.info(`Folder ditargetkan: ${typesDir.path}`);
		logger.info(`Folder ditargetkan: ${validationsDir.path}`);

		// 4. Split berdasarkan baris yang diawali: schema:, form:, dll
		const sections = contentBlock.split(/\n(?=(?:schema|form|table|detail|action|type):)/);

		const files: Array<{ type: string; filename: string; content: string }> = [];

		for (const section of sections) {
			const headerMatch = section.match(/^(schema|form|table|detail|action|type):\s*(.+)$/m);
			if (!headerMatch) {
				continue;
			}

			const [, type, filename] = headerMatch;
			const codeMatch = section.match(/```(?:ts|tsx|js|jsx)\n([\s\S]*?)\n```/);
			const codeContent = codeMatch ? codeMatch[1] : '// Konten kosong atau parsing gagal';

			files.push({
				type,
				filename: filename.trim(),
				content: codeContent
			});
		}

		// 5. Tulis setiap file
		for (const file of files) {
			console.log(file);
			let fileUri = vscode.Uri.joinPath(actionDir, file.filename);
			if (file.type === 'form' || file.type === 'table' || file.type === 'detail') {
				fileUri = vscode.Uri.joinPath(pageDir, file.filename);
			} else if (file.type === 'type') {
				fileUri = vscode.Uri.joinPath(typesDir, file.filename);
			} else if (file.type === 'schema') {
				fileUri = vscode.Uri.joinPath(validationsDir, file.filename);
			}
			const data = Buffer.from(file.content, 'utf8');
			try {
				// Check if the file already exists
				await vscode.workspace.fs.stat(fileUri);
				// If it exists, prompt the user for confirmation to overwrite
				const confirmOverwrite = await vscode.window.showWarningMessage(
					`File ${file.filename} already exists. Do you want to overwrite it?`,
					{ modal: true },
					'Yes',
					'No'
				);

				if (confirmOverwrite !== 'Yes') {
					// User chose not to overwrite, continue to the next file
					console.log(`Skipping file: ${file.filename}`);
					vscode.window.showInformationMessage(`Skipping file: ${file.filename}`);
					continue; // Continue to the next iteration
				}
			} catch (error) {
				// File does not exist, we can proceed to write
			}

			// Now you can safely write to the file, it's either non-existent or the user confirmed overwrite
			await vscode.workspace.fs.writeFile(fileUri, data);
			logger.info(`File created: ${fileUri.path}`);
			vscode.window.showInformationMessage(`✅ File created: ${file.filename}`);
		}

		vscode.window.showInformationMessage(`🎉 All files succesfully created: models/${folderName}`);
	} catch (err: any) {
		logger.error('Failed to write file:', err);
		vscode.window.showErrorMessage('Failed to write file: ' + (err.message || err.toString()));
	}
}

let loadingStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
	loadingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	context.subscriptions.push(loadingStatusBarItem);
	// Disini kita daftarin command
	let disposable = vscode.commands.registerCommand('vibe-coding.writeFile', async () => {
		logger.info("writeFile command triggered");
		await writeFileVico(context, vscode.window.activeTextEditor!);
	});

	context.subscriptions.push(disposable);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("vibeCoding.inline.enabled")) {
				lastSuggestion = null; // clear ghost text
				vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
			}
		})
	);

	const SUPPORTED_LANGUAGES = [
		'javascript',
		'typescript',
		'python',
		'php',
		'go',
		'java',
		'c',
		'cpp',
		'csharp',
		'rust',
		'ruby',
		'json',
		'html',
		'css',
		'bash',
		'yaml',
		'dockerfile',
		'markdown',
		'sql'
	];

	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(
			SUPPORTED_LANGUAGES.map(lang => ({ scheme: 'file', language: lang })),
			{
				provideCompletionItems(document, position) {
					if (!lastSuggestion || !lastSuggestion.trim()) return;

					const item = new vscode.CompletionItem(lastSuggestion, vscode.CompletionItemKind.Snippet);
					item.insertText = new vscode.SnippetString(lastSuggestion);
					item.detail = 'AI Suggestion from Vibe Coding';
					item.sortText = '\u0000';
					item.command = {
						command: 'vibe-coding.clearSuggestion',
						title: ''
					};

					return [item];
				}
			},
			'' // manual trigger
		)
	);


	// Command untuk menghapus suggestion setelah dipilih
	context.subscriptions.push(
		vscode.commands.registerCommand('vibe-coding.clearSuggestion', () => {
			lastSuggestion = null;
		})
	);
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "vibe-coding" is now active!');
	// Register the Sidebar Panel
	const sidebarProvider = new SidebarProvider(context.extensionUri, context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			"vibe-coding-sidebar",
			sidebarProvider
		)
	);

	// Register a command to update the webview with the current file and line information
	context.subscriptions.push(
		vscode.commands.registerCommand('vibe-coding.updateWebview', () => {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const filePath = editor.document.fileName;
				const fileName = path.basename(filePath); // Dapatkan nama file saja
				const selection = editor.selection;
				const startLine = selection.start.line + 1; // Line numbers are 0-based
				const endLine = selection.end.line + 1; // Line numbers are 0-based
				const webview = sidebarProvider._view;
				if (webview) {
					webview.webview.postMessage({
						command: 'updateFileInfo',
						filePath: fileName, // Kirim nama file saja
						selectedLine: `${startLine}-${endLine}` // Kirim rentang baris yang dipilih
					});
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider(
			{ scheme: 'file' },
			{
				async provideInlineCompletionItems(document, position) {
					if (!isInlineEnabled()) return [];
					if (!lastSuggestion) return [];
					if (lastRequestLine !== position.line) return [];

					const lineText = document.lineAt(position.line).text;
					const isNewLine = lineText.trim() === '';

					if (!isNewLine && lastRequestPrefix && !lineText.trim().startsWith(lastRequestPrefix)) {
						return [];
					}

					return [{
						insertText: lastSuggestion,
						range: new vscode.Range(position, position)
					}];
				}
			}
		)
	);



	const debouncedFetch = debounce(() => {
		const editor = vscode.window.activeTextEditor;
		if (editor) fetchSuggestions(context, editor);
	}, 600);


	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((e) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;

			const change = e.contentChanges[0];
			if (!change) return;

			lastSuggestion = null;
			vscode.commands.executeCommand('editor.action.inlineSuggest.hide');

			const isNewLine = change.text === '\n';
			const isTyping = change.text.length > 0 && change.text !== '\n';

			if (isTyping || isNewLine) {
				debouncedFetch();
			}

			if (isNewLine) {
				setTimeout(() => {
					vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
				}, 80);
			}
		})
	);


	vscode.workspace.onDidChangeTextDocument((e) => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const change = e.contentChanges[0];
		if (!change) return;

		// 👉 Detect user tekan Enter
		if (change.text === '\n') {
			setTimeout(() => {
				vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
			}, 50);
		}
	});




	// Trigger the updateWebview command when the active editor changes or the selection changes
	vscode.window.onDidChangeActiveTextEditor(() => {
		vscode.commands.executeCommand('vibe-coding.updateWebview');
	});
	vscode.window.onDidChangeTextEditorSelection(() => {
		vscode.commands.executeCommand('vibe-coding.updateWebview');
	});

	// Initial trigger to update the webview
	vscode.commands.executeCommand('vibe-coding.updateWebview');


	context.subscriptions.push(
		vscode.commands.registerCommand('vibe-coding.applyCodeSelection', (code) => {
			const editor = vscode.window.activeTextEditor;
			console.log("apply code from chat");
			if (editor) {
				const selection = editor.selection;

				editor.edit(editBuilder => {
					// Ganti teks yang dipilih dengan kode baru
					editBuilder.replace(selection, code);
				}).then(() => {
					console.log('Code applied successfully!');
				}, (err) => {
					console.error('Failed to apply code:', err);
				});
			}
		})
	);


	context.subscriptions.push(
		vscode.commands.registerCommand('vibe-coding.fetchSuggestions', () => {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				fetchSuggestions(context, editor);
			} else {
				vscode.window.showInformationMessage("No active text editor found.");
			}
		})
	);



	context.subscriptions.push(
		vscode.commands.registerCommand('vibe-coding.triggerCompletion', () => {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const currentLine = editor.selection.active.line;
				// Lakukan edit untuk menambahkan newline di posisi kursor
				editor.edit(editBuilder => {
					// Sisipkan newline di posisi kursor
					editBuilder.insert(editor.selection.active, '\n');
				}).then(() => {

					const currentLineText = editor.document.lineAt(currentLine).text;


					// Cek apakah baris sebelumnya adalah komentar
					if (/^\s*(\/\/|\/\*|\*|#|<!--)/.test(currentLineText)) {
						console.log("code completion generate..")
						// Jika baris sebelumnya adalah komentar, jalankan logika triggerCodeCompletion
						const allCode = editor.document.getText(); // Dapatkan seluruh kode dari editor
						let coding = currentLineText + '\n'; // Tambahkan baris sebelumnya ke coding

						// Panggil fungsi untuk membersihkan comment dan trigger completion
						const cleanCode = removeCommentTags(coding);
						triggerCodeCompletion(context, cleanCode, allCode);
					}
				});

			}
		})
	);


}

function onUserInput(line: string) {
	// Simpan line ke riwayat
	console.log(line)
}
function removeCommentTags(code: string) {
	return code
		.replace(/\/\/(.*)$/gm, '$1') // Menghapus // dan menyimpan teks setelahnya
		.replace(/\/\*[\s\S]*?\*\//g, '') // Menghapus komentar multi-baris
		.replace(/#(.*)$/gm, '$1') // Menghapus # dan menyimpan teks setelahnya
		.replace(/<!--(.*?)-->/g, '$1') // Menghapus komentar HTML
		.replace(/\n\s*\n/g, '\n') // Menghapus baris kosong yang tersisa
		.trim(); // Menghapus spasi di awal dan akhir
}

async function triggerCodeCompletion(context: vscode.ExtensionContext, comment: string, allCode: string) {
	const allCodeData = "```" + allCode + "```";
	// Logika untuk generate suggestion berdasarkan lineContent
	const token = context.globalState.get<string>('token');
	const editor = vscode.window.activeTextEditor;
	if (editor) {
		const body = {
			userId: 'vscode-user', // Ganti dengan ID pengguna yang sesuai,
			token: token,
			message: `The full code is:\n${allCode}\n\n` +
				`The user is currently typing this line: "${comment}".\n` +
				`Continue this line naturally. Do NOT repeat existing text, and do NOT add braces, semicolons, or syntax that already exists later in the file.`,
		};

		// Buat StatusBarItem untuk loading
		loadingStatusBarItem.text = "🔄 Vibe Coding loading...";
		loadingStatusBarItem.show();

		try {
			const response = await fetch('http://103.250.10.249:13100/api/suggest', {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body)
			});

			// Cek apakah response berhasil
			if (!response.ok) {
				const errorMessage = await response.text();
				throw new Error(`Error ${response.status}: ${errorMessage}`);
			}

			// Jika berhasil, ambil data
			const coding: any = await response.json();

			// Menambahkan hasil sementara ke editor
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const currentLine = editor.selection.active.line;

				// Tampilkan pesan instruksi
				const instructionMessage = "Accept code from Vibe Coding...";

				vscode.window.showInformationMessage(instructionMessage, { modal: true }, "Accept Code", "Decline").then(selection => {
					if (selection === "Accept Code") {
						// Jika pengguna memilih 'Terima Kode'
						editor.edit(editBuilder => {
							// Hapus pesan instruksi jika ada
							const instructionStartPosition = new vscode.Position(currentLine, 0);
							const instructionEndPosition = new vscode.Position(currentLine + 1, 0);
							editBuilder.delete(new vscode.Range(instructionStartPosition, instructionEndPosition));

							// Sisipkan hasil code completion
							editBuilder.insert(new vscode.Position(currentLine, 0), `${coding.message}\n`);
						});
					} else if (selection === "Decline") {
						// Jika pengguna memilih 'Tolak Kode', lakukan sesuatu jika perlu
						console.log("Kode ditolak.");
					}
				});
			}
		} catch (error) {
			console.error(error);
		} finally {
			// Sembunyikan StatusBarItem loading setelah selesai
			loadingStatusBarItem.hide();
		}
	}
}

//implementasi disini

// This method is called when your extension is deactivated
export function deactivate() { }