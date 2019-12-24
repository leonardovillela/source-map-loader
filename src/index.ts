import * as path from "path";
import { getOptions } from "loader-utils";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import { RawSourceMap } from "source-map";
import { loader } from "webpack";

interface Options {
  keepRelativeSources?: boolean;
}

interface SourceAndContent {
  source: string | null;
  content: string | null;
}

const FILE_SCHEME = "file:";

const DEFAULT_OPTIONS: Options = {
  // Prevent the loader to rewrite all sources as absolute paths
  keepRelativeSources: false
};

// Matches only the last occurrence of sourceMappingURL
const baseRegex =
  "\\s*[@#]\\s*sourceMappingURL\\s*=\\s*([^\\s]*)(?![\\S\\s]*sourceMappingURL)";
// Matches /* ... */ comments
const regex1 = new RegExp("/\\*" + baseRegex + "\\s*\\*/");
// Matches // .... comments
const regex2 = new RegExp("//" + baseRegex + "(?:$|\n|\r\n?)");
// Matches DataUrls
const regexDataUrl = /data:[^;\n]+(?:;charset=[^;\n]+)?;base64,([a-zA-Z0-9+/]+={0,2})/;
// Matches url with scheme, doesn't match Windows disk
const regexUrl = /^[a-zA-Z]{2,}:/;

function resolveAbsolutePath(context, url) {
  let filepath = url;
  if (regexUrl.test(filepath) && !filepath.startsWith(FILE_SCHEME)) {
    throw new Error(`URL scheme not supported: ${url}`);
  }
  if (filepath.startsWith(FILE_SCHEME)) {
    if (!fileURLToPath) {
      throw new Error(`File URL scheme support requires node 10.x: ${url}`);
    }
    filepath = fileURLToPath(filepath);
  }
  return path.resolve(context, filepath);
}

async function readSourceMap(
  this: loader.LoaderContext,
  url
): Promise<[RawSourceMap, string]> {
  const dataUrlMatch = regexDataUrl.exec(url);
  if (dataUrlMatch) {
    const base64SourceMap = dataUrlMatch[1];
    try {
      const jsonSourceMap = Buffer.from(base64SourceMap, "base64").toString();
      return [JSON.parse(jsonSourceMap) as RawSourceMap, this.context];
    } catch (ex) {
      let shortenedSourceMap = base64SourceMap.substr(0, 50);
      throw new Error(
        `Cannot parse inline SourceMap '${shortenedSourceMap}': ${ex}`
      );
    }
  } else {
    const absolutePath = resolveAbsolutePath(this.context, url);
    const fileContent = await fs.readFile(absolutePath, "utf-8");
    this.addDependency(absolutePath);
    try {
      return [
        JSON.parse(fileContent) as RawSourceMap,
        path.dirname(absolutePath)
      ];
    } catch (ex) {
      throw new Error(`Cannot parse SourceMap from ${url}: ${ex}`);
    }
  }
}

async function loadSourceMap(
  this: loader.LoaderContext,
  sourceMapUrl,
  { keepRelativeSources }
): Promise<object | null> {
  const [sourceMap, sourcesContext] = await readSourceMap.call(
    this,
    sourceMapUrl
  );

  const sourcePrefix = sourceMap.sourceRoot ? sourceMap.sourceRoot + "/" : "";
  const sources = sourceMap.sources.map(function(s) {
    return sourcePrefix + s;
  });
  delete sourceMap.sourceRoot;
  const sourcesContent = sourceMap.sourcesContent || [];
  const sourcesPromises: Promise<SourceAndContent>[] = sources.map(
    async (source, sourceIndex): Promise<SourceAndContent> => {
      let absolutePath: string;
      try {
        absolutePath = resolveAbsolutePath(sourcesContext, source);
      } catch (ex) {
        this.emitWarning(
          new Error(`Cannot find source file '${source}': ${ex}`)
        );
        return {
          source: source,
          content:
            sourcesContent[sourceIndex] !== null
              ? sourcesContent[sourceIndex]
              : null
        };
      }
      if (
        sourcesContent[sourceIndex] !== null &&
        sourcesContent[sourceIndex] !== undefined
      ) {
        return {
          source: absolutePath,
          content: sourcesContent[sourceIndex]
        };
      }
      let content: string;
      try {
        content = await fs.readFile(absolutePath, "utf-8");
      } catch (ex) {
        this.emitWarning(
          new Error(`Cannot open source file '${absolutePath}': ${ex}`)
        );
        return {
          source: absolutePath,
          content: null
        };
      }
      this.addDependency(absolutePath);
      return {
        source: absolutePath,
        content: content
      };
    }
  );
  const results = await Promise.all(sourcesPromises);
  if (!keepRelativeSources) {
    sourceMap.sources = results.map(res => res.source);
  }
  sourceMap.sourcesContent = results.map(res => res.content);
  return sourceMap;
}

const loader: loader.Loader = function(
  this: loader.LoaderContext,
  rawInputSource,
  rawInputSourceMap
): void {
  if (!rawInputSource || rawInputSourceMap) {
    this.callback(null, rawInputSource, rawInputSourceMap);
    return;
  }

  const options = Object.assign({}, DEFAULT_OPTIONS, getOptions(this));
  this.cacheable && this.cacheable();
  const inputSource =
    typeof rawInputSource === "string"
      ? rawInputSource
      : String(rawInputSource);
  const match = inputSource.match(regex1) || inputSource.match(regex2);

  if (!match) {
    this.callback(null, inputSource, undefined);
    return;
  }

  const callback = this.async();
  loadSourceMap
    .call(this, match[1], options)
    .catch(ex => {
      this.emitWarning(ex);
      return null;
    })
    .then(sourceMap => {
      if (sourceMap) {
        callback(null, inputSource.replace(match[0], ""), sourceMap);
      } else {
        callback(null, inputSource, undefined);
      }
    });
};

export default loader;
