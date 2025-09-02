import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';


export class SidebarProvider implements vscode.WebviewViewProvider {
  public _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri, private readonly context: vscode.ExtensionContext) { }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    const selectedText = webviewView.webview.onDidReceiveMessage((message) => {
      if (message.command === 'getSelectedText') {
        console.log("get selected text");
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const allCode = editor.document.getText();
          const selection = editor.selection;
          const text = editor.document.getText(selection);
          // Kirim ke webview
          webviewView.webview.postMessage({ text, allCode });
        } else {
          // Kirim ke webview
          webviewView.webview.postMessage({ text: '' });
        }
      } else if (message.command === 'applyCodeSelection') {
        const editor = vscode.window.activeTextEditor;
        // console.log("apply code from chat", message.code);
        if (editor) {
          const selection = editor.selection;
          editor.edit(editBuilder => {
            // Ganti teks yang dipilih dengan kode baru
            editBuilder.replace(selection, message.code);
          }).then(() => {
            console.log('Code applied successfully!');
          }, (err) => {
            console.error('Failed to apply code:', err);
          });
        }
      } else if (message.command === 'updateFileInfo') {
        this.updateFileInfo(message.filePath, message.selectedLine);
      }
    });

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'saveToken':
            // Simpan token di globalState
            this.context.globalState.update('token', message.token);
            return;
          case 'writeFile':
            this.context.globalState.update('writeContent', message.assistantMessage);
            await vscode.commands.executeCommand('vibe-coding.writeFile');
            return;
          case 'findFiles':
            try {
              console.log('Searching for files in the workspace...');
              const files = await this.getAllWorkspaceFiles();
              let workspacePath = '';
              if (vscode.workspace.workspaceFolders) {
                workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
              } else {
                let randomNum = Math.floor(Math.random() * 100000);
                workspacePath = randomNum.toString();
              }
              const uniqueInput = `${message.email}:${workspacePath}`; // Gabungkan userId dengan workspacePath

              console.log("workspacePath: ", uniqueInput);
              console.log("files: ", files)
              const token = crypto.createHash('md5').update(uniqueInput).digest('hex');
              console.log("token: ", token)
              this.context.globalState.update('token', token);
              webviewView.webview.postMessage({ command: 'filesFound', files, token });
            } catch (error: any) {
              console.error('Error finding files:', error);
              webviewView.webview.postMessage({ command: 'error', error: error?.message });
            }
            return;
          case 'updateWorkspaces':
            try {
              // Tampilkan prompt kepada pengguna
              const userResponse = await vscode.window.showInformationMessage(
                "This action will train the AI with a sampled subset of the code in your workspace. This process helps the AI understand the context of your code, including its structure and logic. Do you want to proceed? Note: This may include sensitive or private code.",
                { modal: true }, // Modal untuk memastikan pengguna memberikan respons
                "Teach AI Current Code", // Tombol konfirmasi
                "Cancel" // Tombol batal
              );

              if (userResponse === "Teach AI Current Code") {
                // Jika pengguna memilih untuk melanjutkan
                const files = await this.getAllWorkspaceFiles();
                // console.log("files: ", files);
                webviewView.webview.postMessage({ command: 'workspaceCode', files });
              } else {
                // Jika pengguna membatalkan
                console.log("User canceled the AI training.");
                webviewView.webview.postMessage({ command: 'workspaceCodeCancel' });
              }
            } catch (error: any) {
              console.error('Error getting workspace code:', error);
              webviewView.webview.postMessage({ command: 'error', error: error?.message });
            }
            return;
        }
      },
      undefined,
      this.context.subscriptions
    );
  }

  private maxTokens = 10000;
  private targetSize = 40000; // sekitar 10k token (1 token ≈ 4 karakter)
  private maxFilesPerFolder = 2;

  async getAllWorkspaceFiles(): Promise<string> {
    try {
      const files = await vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.git/**,**/.svn/**,**/.hg/**,**/.next/**,**/.nuxt/**,**/.expo/**,**/vendor/**,**/__pycache__/**,**/.pytest_cache/**,**/.idea/**,**/.vscode/**,**/.vs/**,**/coverage/**,**/bin/**,**/obj/**,**/target/**,**/Pods/**,**/env/**,**/.env/**,**/tmp/**,**/temp/**,**/*.log,**/*.lock,**/*.zip,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.exe,**/*.dll,**/*.bin,**/*.class,**/*.so,**/*.o,**/*.a}'
      );

      const folderBuckets: Record<string, { path: string; code: string; priority: boolean; config: boolean }[]> = {};

      for (const file of files) {
        if (!this.isTextFile(file.fsPath)) continue;

        const document = await vscode.workspace.openTextDocument(file);
        const raw = document.getText();
        const priority = this.isPriorityFile(file.fsPath);
        const config = this.isConfigFile(file.fsPath);
        const compressed = priority
          ? this.stripComments(raw)
          : this.compressCodeSkeleton(raw);

        if (compressed.length === 0) continue;

        const folderName = path.dirname(file.fsPath);
        if (!folderBuckets[folderName]) folderBuckets[folderName] = [];
        folderBuckets[folderName].push({ path: file.fsPath, code: compressed, priority, config });
      }

      const selectedFiles: { path: string; code: string; priority: boolean; config: boolean }[] = [];
      for (const folder of Object.keys(folderBuckets)) {
        const priorityFiles = folderBuckets[folder].filter(f => f.priority);
        const normalFiles = folderBuckets[folder].filter(f => !f.priority && !f.config);
        const configFiles = folderBuckets[folder].filter(f => f.config);

        // urutkan berdasarkan nama file (tidak random)
        priorityFiles.sort((a, b) => a.path.localeCompare(b.path));
        normalFiles.sort((a, b) => a.path.localeCompare(b.path));
        configFiles.sort((a, b) => a.path.localeCompare(b.path));

        // ambil max 3 file prioritas dulu
        priorityFiles.slice(0, this.maxFilesPerFolder).forEach(f => selectedFiles.push(f));

        const remainingSlots = this.maxFilesPerFolder - Math.min(priorityFiles.length, this.maxFilesPerFolder);
        if (remainingSlots > 0) {
          normalFiles.slice(0, remainingSlots).forEach(f => selectedFiles.push(f));
        }

        // Jika slot masih kosong, baru masukkan config
        const finalSlots = this.maxFilesPerFolder - selectedFiles.filter(f => path.dirname(f.path) === folder).length;
        if (finalSlots > 0) {
          configFiles.slice(0, finalSlots).forEach(f => selectedFiles.push(f));
        }
      }

      // Group output berdasarkan folder
      const grouped: Record<string, { path: string; code: string; priority: boolean; config: boolean }[]> = {};
      for (const f of selectedFiles) {
        const folderKey = f.path.includes("/src/")
          ? "src/" + f.path.split("/src/")[1].split("/")[0]
          : "(root)";
        if (!grouped[folderKey]) grouped[folderKey] = [];
        grouped[folderKey].push(f);
      }

      // Gabungkan hasil dengan batas ukuran
      let allCode = '';
      let totalSize = 0;
      console.log('=== FILES SELECTED TO SEND ===');

      for (const folder of Object.keys(grouped)) {
        const folderHeader = `\n\n// ===== Folder: ${folder} =====\n`;
        if (totalSize + folderHeader.length <= this.targetSize) {
          allCode += folderHeader;
          totalSize += folderHeader.length;
        } else {
          console.log(`- SKIPPED FOLDER (limit) ${folder}`);
          continue;
        }

        for (const f of grouped[folder]) {
          const snippet = `// File: ${f.path}\n${f.code}\n\n`;
          if (totalSize + snippet.length <= this.targetSize) {
            allCode += snippet;
            totalSize += snippet.length;
            console.log(`+ ${f.path} (${f.priority ? 'PRIORITY' : f.config ? 'CONFIG' : 'normal'})`);
          } else {
            console.log(`- SKIPPED (limit) ${f.path}`);
          }
        }
      }

      console.log('=== END OF FILE LIST ===');
      return allCode;

    } catch (err) {
      console.error('Error reading workspace files:', err);
      return '';
    }
  }

  // --- Hapus komentar, tapi biarkan kode utuh ---
  private stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/^\s*#.*$/gm, '')
      .replace(/^\s*$/gm, '')
      .trim();
  }

  // --- Skeleton code untuk semua bahasa ---
  private compressCodeSkeleton(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/^\s*#.*$/gm, '')

      // Functions
      .replace(/(function\s+\w+\s*\(.*?\))\s*\{[\s\S]*?\}/g, '$1;')
      .replace(/(const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{[\s\S]*?\}/g, '$1 $2 = (...): ... => { ... };')
      .replace(/(export\s+function\s+\w+)\s*\([^)]*\)\s*:\s*JSX\.Element\s*\{[\s\S]*?\}/g, '$1(...): JSX.Element;')

      // Classes
      .replace(/(class\s+\w+)(<.*?>)?\s*\{[\s\S]*?\}/g, '$1$2 { ... }')

      // Types
      .replace(/(type\s+\w+\s*=\s*)[\s\S]*?(?=\n\S|\n$)/g, '$1...;')
      .replace(/(interface\s+\w+\s*)\{[\s\S]*?\}/g, '$1{ ... }')
      .replace(/(enum\s+\w+\s*)\{[\s\S]*?\}/g, '$1{ ... }')

      // Schemas
      .replace(/(z\.ZodObject<.*?>\s*=\s*)\{[\s\S]*?\}/g, '$1...;')
      .replace(/(const\s+\w+Schema\s*=\s*\w+\.object\(.*)\)\s*;/g, '$1 ... });')

      // Stores
      .replace(/(const\s+use\w+Store\s*=\s*create<.*?>\s*\()([\s\S]*?\}\s*\))/g, '$1... => { ... }$2')

      // Routes
      .replace(/(app\.(get|post|put|delete|patch)\(.*?,\s*)(\(.*?\)\s*=>\s*)?\{[\s\S]*?\}/g, '$1$3{ ... }')

      // Python, Go, Rust
      .replace(/(def\s+\w+\s*\(.*?\):)[\s\S]*?(?=\n\S|\n$)/g, '$1 ...')
      .replace(/(func\s+\w+\s*\(.*?\)\s*.*)\{[\s\S]*?\}/g, '$1 { ... }')
      .replace(/(fn\s+\w+\s*\(.*?\)\s*.*)\{[\s\S]*?\}/g, '$1 { ... }')

      .replace(/^\s*$/gm, '')
      .trim();
  }

  // --- Deteksi file teks ---
  private isTextFile(filePath: string): boolean {
    const exts = [
      '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro',
      '.php', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.cs', '.scala', '.kt',
      '.html', '.css', '.scss', '.json', '.md', '.txt', '.xml', '.yml', '.yaml', '.ini', '.env',
      '.ejs', '.hbs', '.pug', '.njk'
    ];
    const ext = path.extname(filePath).toLowerCase();
    return exts.includes(ext);
  }

  // --- Deteksi file prioritas ---
  private isPriorityFile(filePath: string): boolean {
    return /(model|schema|entity|types?|interfaces?|dto|config|api|routes?|validation)/i.test(filePath);
  }

  // --- Deteksi file config ---
  private isConfigFile(filePath: string): boolean {
    const configPatterns = [
      "eslint.config.js",
      "tsconfig.json",
      "tsconfig.app.json",
      "tsconfig.node.json",
      "vite.config",
      "webpack.config",
      "postcss.config",
      "tailwind.config",
      "package.json",
    ];
    return configPatterns.some(p => filePath.includes(p));
  }



  private updateFileInfo(filePath: string, selectedLine: number) {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'updateFileInfo',
        filePath: filePath,
        selectedLine: selectedLine
      });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const htmlPath = path.join(this._extensionUri.fsPath, 'media', 'webview.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const logoPath = webview.asWebviewUri(vscode.Uri.file(path.join(this._extensionUri.fsPath, 'media', 'logo.png')));
    const stylesPath = webview.asWebviewUri(vscode.Uri.file(path.join(this._extensionUri.fsPath, 'media', 'styles.css')));
    const prismPath = webview.asWebviewUri(vscode.Uri.file(path.join(this._extensionUri.fsPath, 'media', 'prism.css')));
    const prismJSPath = webview.asWebviewUri(vscode.Uri.file(path.join(this._extensionUri.fsPath, 'media', 'prism.js')));
    const chara = webview.asWebviewUri(vscode.Uri.file(path.join(this._extensionUri.fsPath, 'media', 'Syana Isniya.vrm')));
    const audio = webview.asWebviewUri(vscode.Uri.file(path.join(this._extensionUri.fsPath, 'media', 'welcome.mp3')));
    const vrm = webview.asWebviewUri(vscode.Uri.file(path.join(this._extensionUri.fsPath, 'node_modules/@pixiv/three-vrm/lib/', 'three-vrm.module.js')));
    const background = webview.asWebviewUri(vscode.Uri.file(path.join(this._extensionUri.fsPath, 'media', 'celestia-bg.jpg')));

    // Replace placeholder with actual logo path htmlContent = htmlContent.replace('%LOGO_PATH%', logoPath.toString());
    htmlContent = htmlContent.replace('%LOGO_PATH%', logoPath.toString());
    htmlContent = htmlContent.replace('%STYLES_PATH%', stylesPath.toString());
    htmlContent = htmlContent.replace('%PRISM_PATH%', prismPath.toString());
    htmlContent = htmlContent.replace('%PRISMJS_PATH%', prismJSPath.toString());
    console.log(chara.toString())
    htmlContent = htmlContent.replace('%CHARA%', chara.toString());
    htmlContent = htmlContent.replace('%VRM%', vrm.toString());
    htmlContent = htmlContent.replace('%AUDIO%', audio.toString());
    htmlContent = htmlContent.replace('%BACKGROUND%', background.toString());
    return htmlContent;
  }
}