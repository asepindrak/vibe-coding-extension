// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';
import * as path from 'path';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

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

async function fetchSuggestions(context: vscode.ExtensionContext, editor: vscode.TextEditor) {
	const currentLine = editor.selection.active.line;
	const lineText = editor.document.lineAt(currentLine).text;

	// Remove comments and prepare the input for the API
	const cleanedInput = removeCommentTags(lineText.trim());

	if (cleanedInput) {
		const allCode = editor.document.getText();
		const token = context.globalState.get('token'); // Get your token
		const filePath = editor.document.fileName;
		const fileName = path.basename(filePath); // Dapatkan nama file saja
		// Buat StatusBarItem untuk loading
		const loadingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		loadingStatusBarItem.text = "🔄 Code Sugestion from Vibe Coding...";
		loadingStatusBarItem.show();
		console.log("Fetching suggestions for:", cleanedInput);
		const body = {
			userId: 'vscode-user',
			token: token,
			message:
				`The full code is:\n${allCode}\n\n` +
				`The user is currently typing this line: "${cleanedInput}".\n` +
				`Continue this line naturally. Do NOT repeat existing text, and do NOT add braces, semicolons, or syntax that already exists later in the file.`
		};


		try {
			const response = await fetch('http://103.250.10.249:5678/webhook/01fe259e-4cf2-438f-9d99-69ea451e55f7', {
				method: 'POST',
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

			const suggestions: any = await response.json();
			presentSuggestions(suggestions.message);
		} catch (error) {
			console.error('Error while fetching suggestions:', error);
		} finally {
			// Sembunyikan StatusBarItem loading setelah selesai
			loadingStatusBarItem.hide();
		}
	}
}
let lastSuggestion: string | null = null;

async function presentSuggestions(suggestion: string) {
	console.log("Presenting suggestion:", suggestion);

	if (suggestion && suggestion.trim().length > 0) {
		lastSuggestion = suggestion;

		// Beri jeda kecil agar state update
		await new Promise(resolve => setTimeout(resolve, 50));

		// Trigger autocomplete
		await vscode.commands.executeCommand('editor.action.triggerSuggest');
	} else {
		vscode.window.showInformationMessage("No suggestions available.");
	}
}


export function activate(context: vscode.ExtensionContext) {

	vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file', language: "php" },
		{
			provideCompletionItems(document, position, token, context) {
				// Jika tidak ada suggestion, return null (jangan error)
				if (!lastSuggestion || lastSuggestion.trim() === '') {
					return undefined;
				}

				// Ambil posisi kursor
				const linePrefix = document.lineAt(position).text.substr(0, position.character);

				// Buat completion item
				const item = new vscode.CompletionItem(lastSuggestion, vscode.CompletionItemKind.Snippet);
				item.insertText = new vscode.SnippetString(lastSuggestion);
				item.detail = 'AI Suggestion from Vibe Coding';
				item.sortText = '\u0000'; // Karakter null — paling awal dalam urutan Unicode
				item.filterText = lastSuggestion; // Opsional: kontrol pencarian
				item.command = {
					command: 'vibe-coding.clearSuggestion',
					title: ''
				};

				return [item];
			}
		},
		'' // Trigger manual
	);

	vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file', language: "javascript" },
		{
			provideCompletionItems(document, position, token, context) {
				// Jika tidak ada suggestion, return null (jangan error)
				if (!lastSuggestion || lastSuggestion.trim() === '') {
					return undefined;
				}

				// Ambil posisi kursor
				const linePrefix = document.lineAt(position).text.substr(0, position.character);

				// Buat completion item
				const item = new vscode.CompletionItem(lastSuggestion, vscode.CompletionItemKind.Snippet);
				item.insertText = new vscode.SnippetString(lastSuggestion);
				item.detail = 'AI Suggestion from Vibe Coding';
				item.command = {
					command: 'vibe-coding.clearSuggestion',
					title: ''
				};

				return [item];
			}
		},
		'' // Trigger manual
	);

	vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file', language: "typescript" },
		{
			provideCompletionItems(document, position, token, context) {
				// Jika tidak ada suggestion, return null (jangan error)
				if (!lastSuggestion || lastSuggestion.trim() === '') {
					return undefined;
				}

				// Ambil posisi kursor
				const linePrefix = document.lineAt(position).text.substr(0, position.character);

				// Buat completion item
				const item = new vscode.CompletionItem(lastSuggestion, vscode.CompletionItemKind.Snippet);
				item.insertText = new vscode.SnippetString(lastSuggestion);
				item.detail = 'AI Suggestion from Vibe Coding';
				item.command = {
					command: 'vibe-coding.clearSuggestion',
					title: ''
				};

				return [item];
			}
		},
		'' // Trigger manual
	);

	vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file', language: "python" },
		{
			provideCompletionItems(document, position, token, context) {
				// Jika tidak ada suggestion, return null (jangan error)
				if (!lastSuggestion || lastSuggestion.trim() === '') {
					return undefined;
				}

				// Ambil posisi kursor
				const linePrefix = document.lineAt(position).text.substr(0, position.character);

				// Buat completion item
				const item = new vscode.CompletionItem(lastSuggestion, vscode.CompletionItemKind.Snippet);
				item.insertText = new vscode.SnippetString(lastSuggestion);
				item.detail = 'AI Suggestion from Vibe Coding';
				item.command = {
					command: 'vibe-coding.clearSuggestion',
					title: ''
				};

				return [item];
			}
		},
		'' // Trigger manual
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
		vscode.commands.registerCommand('vibe-coding.testSuggestion', () => {
			presentSuggestions("$nomor_kantor = mysqli_real_escape_string($conn, trim($_POST['nomor_kantor']));");
		})
	);

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



	const fetchSuggestionsDebounced = debounce((editor: vscode.TextEditor) => {
		fetchSuggestions(context, editor);
	}, 3000); // Adjust the debounce time as needed

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((event) => {
			const editor = vscode.window.activeTextEditor;
			if (editor && event.document === editor.document) {
				fetchSuggestionsDebounced(editor); // fetch hanya saat user mengedit teks
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
		const loadingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		loadingStatusBarItem.text = "🔄 Vibe Coding loading...";
		loadingStatusBarItem.show();

		try {
			const response = await fetch('http://103.250.10.249:5678/webhook/01fe259e-4cf2-438f-9d99-69ea451e55f7', {
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