(function () {
  function extractReadFileTargets(text) {
    const readTargets = [];
    const seen = new Set();
    const value = String(text || "");
    const readFileRegex = /\[readFile(?:[^\]]+)?\]([\s\S]*?)\[\/readFile\]/gi;
    const tagAttributeRegex =
      /\[readFile\s+(?:file|path)=["']([^"']+)["']\s*\]/gi;
    let match;

    while ((match = readFileRegex.exec(value)) !== null) {
      const content = String(match[1] || "").trim();
      if (content && !content.includes("[file")) {
        if (!seen.has(content)) {
          seen.add(content);
          readTargets.push(content);
        }
      } else if (content.includes("[file")) {
        const filePathsRegex = /\[file\s+path=["']([^"']+)["']\s*\]/g;
        let fileMatch;
        while ((fileMatch = filePathsRegex.exec(content)) !== null) {
          const filePath = String(fileMatch[1] || "").trim();
          if (filePath && !seen.has(filePath)) {
            seen.add(filePath);
            readTargets.push(filePath);
          }
        }
      }
    }

    tagAttributeRegex.lastIndex = 0;
    while ((match = tagAttributeRegex.exec(value)) !== null) {
      const filePath = String(match[1] || "").trim();
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        readTargets.push(filePath);
      }
    }

    return readTargets;
  }

  function appendSystemLogMarkdown(markdown, message) {
    return String(markdown || "") + "\n  > *" + String(message || "") + "*";
  }

  function createDiscoveryDisplay(resultText, maxLength) {
    const text = String(resultText || "");
    if (text.length > (maxLength || 500)) {
      return text.slice(0, maxLength || 500) + "\n... (truncated)";
    }
    return text;
  }

  function extractTopDiscoveryPath(resultText) {
    const text = String(resultText || "");
    const line = text
      .split(/\r?\n/)
      .map(function (value) {
        return value.trim();
      })
      .find(function (value) {
        return (
          value &&
          !/^error:/i.test(value) &&
          !/^no (matches|symbols|files)/i.test(value) &&
          !/^invalid regex/i.test(value)
        );
      });

    if (!line) return "";
    const match = line.match(/^(.+?):\d+:\s/);
    return match ? match[1].trim() : "";
  }

  function buildDiscoverySuggestion(resultText, label) {
    const topPath = extractTopDiscoveryPath(resultText);
    if (!topPath) return "";
    return (
      "\nTop " +
      (label || "discovery") +
      ' candidate to read next: [readFile][file path="' +
      topPath +
      '"][/readFile]\n'
    );
  }

  function buildDiscoveryContextBlock(label, query, resultText) {
    const result = String(resultText || "");
    const title = String(label || "Results");
    const queryText = String(query || "").trim();
    return (
      "\n" +
      title +
      ' for "' +
      queryText +
      '":\n' +
      result +
      "\n" +
      buildDiscoverySuggestion(result, title.toLowerCase().replace(/\s+/g, " "))
    );
  }

  function isEmptyDiscoveryResult(resultText, emptyPrefix) {
    return new RegExp(
      "^" + String(emptyPrefix || "No results") + "\\.",
      "i",
    ).test(String(resultText || "").trim());
  }

  function waitForMessageResponse(vscode, options) {
    return new Promise(function (resolve, reject) {
      let handleMessage;
      let handleStop;
      const timeout = setTimeout(function () {
        window.removeEventListener("message", handleMessage);
        window.removeEventListener("agent-stop", handleStop);
        resolve(options.timeoutResult);
      }, options.timeoutMs || 10000);

      handleStop = function () {
        clearTimeout(timeout);
        window.removeEventListener("message", handleMessage);
        window.removeEventListener("agent-stop", handleStop);
        const err = new Error("Aborted by user");
        err.name = "AbortError";
        reject(err);
      };

      handleMessage = function (event) {
        if (
          event.data.command === "systemLog" &&
          typeof options.onSystemLog === "function"
        ) {
          options.onSystemLog(event.data.message);
        }
        if (
          event.data.command === options.responseCommand &&
          (!options.matchesEvent || options.matchesEvent(event.data))
        ) {
          clearTimeout(timeout);
          window.removeEventListener("message", handleMessage);
          window.removeEventListener("agent-stop", handleStop);
          resolve(options.extractResult(event.data));
        }
      };

      window.addEventListener("message", handleMessage);
      window.addEventListener("agent-stop", handleStop);
      vscode.postMessage(options.request);
    });
  }

  function requestReadFile(vscode, options) {
    return waitForMessageResponse(vscode, {
      request: { type: "readFile", filePath: options.filePath },
      responseCommand: "readFileResult",
      timeoutMs: options.timeoutMs || 15000,
      timeoutResult: "Error: Timeout reading file " + options.filePath,
      matchesEvent: function (eventData) {
        return eventData.filePath === options.filePath;
      },
      extractResult: function (eventData) {
        if (
          eventData.resolvedPath &&
          eventData.resolvedPath !== options.filePath &&
          options.filePathCache
        ) {
          options.filePathCache.set(options.filePath, eventData.resolvedPath);
        }
        return eventData.content || eventData.error || "";
      },
    });
  }

  function requestSearch(vscode, options) {
    return waitForMessageResponse(vscode, {
      request: { command: "search", query: options.query },
      responseCommand: "searchResult",
      timeoutMs: options.timeoutMs || 60000,
      timeoutResult: "Error: Timeout searching files.",
      onSystemLog: options.onSystemLog,
      extractResult: function (eventData) {
        return eventData.results || eventData.error || "No matches.";
      },
    });
  }

  function requestSymbolSearch(vscode, options) {
    return waitForMessageResponse(vscode, {
      request: { command: "searchSymbols", query: options.query },
      responseCommand: "searchSymbolsResult",
      timeoutMs: options.timeoutMs || 60000,
      timeoutResult: "Error: Timeout searching symbols.",
      onSystemLog: options.onSystemLog,
      extractResult: function (eventData) {
        return eventData.results || eventData.error || "No symbols.";
      },
    });
  }

  function requestFindFiles(vscode, options) {
    return waitForMessageResponse(vscode, {
      request: { command: "listFiles", pattern: options.pattern },
      responseCommand: "listFilesResult",
      timeoutMs: options.timeoutMs || 60000,
      timeoutResult: "Error: Timeout finding files.",
      onSystemLog: options.onSystemLog,
      extractResult: function (eventData) {
        return eventData.files
          ? eventData.files.join("\n")
          : eventData.error || "No files found.";
      },
    });
  }

  async function runDiscoveryRequest(options) {
    const result = await options.request({
      onSystemLog: function (message) {
        if (typeof options.onSystemLog === "function") {
          options.onSystemLog(message);
        }
      },
    });

    if (typeof options.onResult === "function") {
      options.onResult(result);
    }

    const nextContext =
      String(options.context || "") +
      buildDiscoveryContextBlock(options.label, options.query, result);
    const nextMarkdown =
      String(options.markdown || "") +
      "\n  > *" +
      String(options.successLabel || "Discovery complete") +
      ".*\n" +
      "\n```\n" +
      createDiscoveryDisplay(result, options.maxDisplayLength || 500) +
      "\n```\n";

    return {
      result: result,
      context: nextContext,
      markdown: nextMarkdown,
      isEmpty: isEmptyDiscoveryResult(result, options.emptyPrefix),
    };
  }

  window.VicoDiscoveryHelpers = {
    extractReadFileTargets: extractReadFileTargets,
    appendSystemLogMarkdown: appendSystemLogMarkdown,
    createDiscoveryDisplay: createDiscoveryDisplay,
    extractTopDiscoveryPath: extractTopDiscoveryPath,
    buildDiscoverySuggestion: buildDiscoverySuggestion,
    buildDiscoveryContextBlock: buildDiscoveryContextBlock,
    isEmptyDiscoveryResult: isEmptyDiscoveryResult,
    waitForMessageResponse: waitForMessageResponse,
    requestReadFile: requestReadFile,
    requestSearch: requestSearch,
    requestSymbolSearch: requestSymbolSearch,
    requestFindFiles: requestFindFiles,
    runDiscoveryRequest: runDiscoveryRequest,
  };
})();
