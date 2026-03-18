(function () {
  const discovery = () => window.VicoDiscoveryHelpers || {};

  async function runThinkDiscovery(options) {
    const {
      extractReadFileTargets,
      requestReadFile,
      requestSearch,
      requestSymbolSearch,
      requestFindFiles,
      runDiscoveryRequest,
      appendSystemLogMarkdown,
      buildDiscoveryContextBlock,
      createDiscoveryDisplay,
    } = discovery();

    let context = options.context || "";
    let currentStepMarkdown = options.markdown || "";
    const filesReadInThisStep = new Set();

    const pushUpdate = function () {
      options.updateMessagesAssistant({
        uniqueId: `assistant-${options.uniqueId}`,
        content: currentStepMarkdown,
      });
    };

    const ensureStillLoading = function () {
      const err = new Error("Aborted by user");
      err.name = "AbortError";
      if (!options.isLoading()) throw err;
    };

    const doReadFile = async function (filePath) {
      try {
        const fileContent = await requestReadFile(options.vscode, {
          filePath,
          timeoutMs: 15000,
          filePathCache: options.filePathCache,
        });

        ensureStillLoading();
        context = options.upsertFileInContext(context, filePath, fileContent);
        currentStepMarkdown += `\n[terminal status="success" command="readFile ${filePath}"]Read complete: ${filePath}[/terminal]\n`;
        pushUpdate();
      } catch (e) {
        context += `\nError reading file ${filePath}: ${e}\n`;
        currentStepMarkdown += `\n[terminal status="error" command="readFile ${filePath}"]Error reading file: ${e}[/terminal]\n`;
        pushUpdate();
      }
    };

    const requestedFiles = extractReadFileTargets(options.thinkOutput);
    for (const filePath of requestedFiles) {
      if (!filesReadInThisStep.has(filePath)) {
        filesReadInThisStep.add(filePath);
        await doReadFile(filePath);
      }
    }

    const searchSymbolsMatch = String(options.thinkOutput || "").match(
      /\[searchSymbols\]([\s\S]*?)\[\/searchSymbols\]/i,
    );
    if (searchSymbolsMatch) {
      const query = searchSymbolsMatch[1].trim();
      currentStepMarkdown += `\n  > *Searching symbols for:* \`${query}\`\n`;
      pushUpdate();

      try {
        const symbolDiscovery = await runDiscoveryRequest({
          context,
          markdown: currentStepMarkdown,
          label: "Symbol Search Results",
          query,
          successLabel: "Symbol search complete",
          emptyPrefix: "No symbols found",
          request: ({ onSystemLog }) =>
            requestSymbolSearch(options.vscode, {
              query,
              timeoutMs: 60000,
              onSystemLog,
            }),
          onSystemLog: (message) => {
            currentStepMarkdown = appendSystemLogMarkdown(
              currentStepMarkdown,
              message,
            );
            pushUpdate();
          },
        });

        ensureStillLoading();
        context = symbolDiscovery.context;
        currentStepMarkdown = symbolDiscovery.markdown;

        if (symbolDiscovery.isEmpty) {
          currentStepMarkdown += `\n  > *No symbols found. Falling back to text search with the same query.*\n`;
          pushUpdate();

          const fallbackDiscovery = await runDiscoveryRequest({
            context,
            markdown: currentStepMarkdown,
            label: "Fallback Text Search Results",
            query,
            successLabel: "Fallback text search complete",
            emptyPrefix: "No matches found",
            request: ({ onSystemLog }) =>
              requestSearch(options.vscode, {
                query,
                timeoutMs: 60000,
                onSystemLog,
              }),
          });

          context = fallbackDiscovery.context;
          currentStepMarkdown = fallbackDiscovery.markdown;
        }
        pushUpdate();
      } catch (e) {
        context += `\nError searching symbols: ${e}\n`;
      }
    }

    const searchFilesMatch = String(options.thinkOutput || "").match(
      /\[searchFiles\]([\s\S]*?)\[\/searchFiles\]/i,
    );
    if (searchFilesMatch) {
      const query = searchFilesMatch[1].trim();
      currentStepMarkdown += `\n  > *Searching for:* \`${query}\`\n`;
      pushUpdate();

      try {
        const searchDiscovery = await runDiscoveryRequest({
          context,
          markdown: currentStepMarkdown,
          label: "Search Results",
          query,
          successLabel: "Search complete",
          emptyPrefix: "No matches found",
          request: ({ onSystemLog }) =>
            requestSearch(options.vscode, {
              query,
              timeoutMs: 60000,
              onSystemLog,
            }),
          onSystemLog: (message) => {
            currentStepMarkdown = appendSystemLogMarkdown(
              currentStepMarkdown,
              message,
            );
            pushUpdate();
          },
        });

        ensureStillLoading();
        context = searchDiscovery.context;
        currentStepMarkdown = searchDiscovery.markdown;
        pushUpdate();
      } catch (e) {
        context += `\nError searching: ${e}\n`;
      }
    }

    const findFilesMatch = String(options.thinkOutput || "").match(
      /\[findFiles\]([\s\S]*?)\[\/findFiles\]/i,
    );
    if (findFilesMatch) {
      const pattern = findFilesMatch[1].trim();
      currentStepMarkdown += `\n  > *Finding files:* \`${pattern}\`\n`;
      pushUpdate();

      let findResult = "";
      try {
        if (options.filePathCache && options.filePathCache.has(pattern)) {
          findResult = options.filePathCache.get(pattern);
          currentStepMarkdown += `\n  > *Found in cache.*\n`;
          console.log(`[webview] Cache hit for pattern: ${pattern}`);
        } else {
          const findDiscovery = await runDiscoveryRequest({
            context,
            markdown: currentStepMarkdown,
            label: "Files Found",
            query: pattern,
            successLabel: "Find complete",
            emptyPrefix: "No files found",
            request: ({ onSystemLog }) =>
              requestFindFiles(options.vscode, {
                pattern,
                timeoutMs: 60000,
                onSystemLog,
              }),
            onSystemLog: (message) => {
              currentStepMarkdown = appendSystemLogMarkdown(
                currentStepMarkdown,
                message,
              );
              pushUpdate();
            },
          });
          findResult = findDiscovery.result;
          context = findDiscovery.context;
          currentStepMarkdown = findDiscovery.markdown;

          if (findResult && !findResult.startsWith("Error")) {
            if (options.filePathCache) {
              options.filePathCache.set(pattern, findResult);
              if (typeof options.saveState === "function") options.saveState();
            }
          }
        }

        ensureStillLoading();

        if (options.filePathCache && options.filePathCache.has(pattern)) {
          context += buildDiscoveryContextBlock(
            "Files Found",
            pattern,
            findResult,
          );
          currentStepMarkdown += `\n  > *Find complete.*\n`;
          currentStepMarkdown += `\n\`\`\`\n${createDiscoveryDisplay(findResult, 500)}\n\`\`\`\n`;
        }
        pushUpdate();
      } catch (e) {
        context += `\nError finding files: ${e}\n`;
      }
    }

    return {
      context,
      markdown: currentStepMarkdown,
      filesReadInThisStep: Array.from(filesReadInThisStep),
    };
  }

  window.VicoThinkHelpers = {
    runThinkDiscovery,
  };
  window.runThinkDiscovery = runThinkDiscovery;
})();
