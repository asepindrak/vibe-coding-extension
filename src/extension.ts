// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';
import * as path from 'path';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

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
	const token = context.globalState.get('token'); // Ambil token dari globalState
	const body = {
		code: `this is the full code from editor ${allCodeData}. continue the code from instruction comment: "${comment}". Provide only the code without triple backtick and programming language, with comments for additional lines.`,
	};

	// Buat StatusBarItem untuk loading
	const loadingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	loadingStatusBarItem.text = "🔄 Memuat kode dari Vibe Coding...";
	loadingStatusBarItem.show();

	try {
		const response = await fetch('https://chat.vibe-coding.my.id/api/code', {
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
			const instructionMessage = "Pilih untuk menerima kode dari Vibe Coding...";

			vscode.window.showInformationMessage(instructionMessage, { modal: true }, "Terima Kode", "Tolak Kode").then(selection => {
				if (selection === "Terima Kode") {
					// Jika pengguna memilih 'Terima Kode'
					editor.edit(editBuilder => {
						// Hapus pesan instruksi jika ada
						const instructionStartPosition = new vscode.Position(currentLine, 0);
						const instructionEndPosition = new vscode.Position(currentLine + 1, 0);
						editBuilder.delete(new vscode.Range(instructionStartPosition, instructionEndPosition));

						// Sisipkan hasil code completion
						editBuilder.insert(new vscode.Position(currentLine, 0), `${coding}\n`);
					});
				} else if (selection === "Tolak Kode") {
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

// This method is called when your extension is deactivated
export function deactivate() { }