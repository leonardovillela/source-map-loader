import * as path from "path";
import { promises as fs } from "fs";
import loader from "../src";
import { RawSourceMap } from "source-map";

const fixturesPath = path.resolve(__dirname, "..", "test", "fixtures");

type ExecResult = {
  res: string | Buffer;
  map: RawSourceMap | undefined;
  warns: Error[];
  deps: string[];
};

const execLoader = async (filename: string): Promise<ExecResult> => {
  let async: boolean = false;
  const deps: string[] = [];
  const warns: Error[] = [];
  let callback;
  const callbackPromise = new Promise<Pick<ExecResult, "res" | "map">>(
    (resolve, reject) => {
      callback = function(err, res, map) {
        async = true;
        if (err) {
          reject(err);
        } else {
          resolve({ res, map });
        }
      };
    }
  );
  const context = {
    context: path.dirname(filename),
    addDependency(dep) {
      deps.push(dep);
    },
    emitWarning(warn: Error) {
      warns.push(warn);
    },
    callback,
    async() {
      async = true;
      return this.callback;
    }
  };
  const rawFixtureContent = await fs.readFile(filename, "utf-8");
  // Remove CRs to make test line ending invariant
  const fixtureContent = rawFixtureContent.replace(/\r/g, "");
  let res = loader.call(context, fixtureContent, undefined);
  let map = undefined;
  if (async) {
    ({ res, map } = await callbackPromise);
  }
  return { res, map, deps, warns };
};

describe("source-map-loader", function() {
  const dataPath = path.join(fixturesPath, "data");

  it("should leave normal files untouched", async () => {
    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, "normal-file.js")
    );
    expect(warns).toHaveLength(0);
    expect(res).toBe("without SourceMap");
    expect(map).toBeUndefined();
    expect(deps).toHaveLength(0);
  });

  it("should process inlined SourceMaps", async () => {
    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, "inline-source-map.js")
    );
    expect(warns).toHaveLength(0);
    expect(res).toEqual("with SourceMap\n// comment");
    expect(map).toEqual({
      version: 3,
      file: "inline-source-map.js",
      sources: [path.join(fixturesPath, "inline-source-map.txt")],
      sourcesContent: ["with SourceMap"],
      mappings: "AAAA"
    });
    expect(deps).toHaveLength(0);
  });

  it("should process external SourceMaps", async () => {
    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, "external-source-map.js")
    );
    expect(warns).toHaveLength(0);
    expect(res).toEqual("with SourceMap\n// comment");
    expect(map).toEqual({
      version: 3,
      file: "external-source-map.js",
      sources: [path.join(fixturesPath, "external-source-map.txt")],
      sourcesContent: ["with SourceMap"],
      mappings: "AAAA"
    });
    expect(deps).toEqual([path.join(fixturesPath, "external-source-map.map")]);
  });

  it("should process external SourceMaps (external sources)", async () => {
    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, "external-source-map2.js")
    );
    expect(warns).toHaveLength(0);
    expect(res).toEqual("with SourceMap\n// comment");
    expect(map).toEqual({
      version: 3,
      file: "external-source-map2.js",
      sources: [path.join(fixturesPath, "external-source-map2.txt")],
      sourcesContent: ["with SourceMap"],
      mappings: "AAAA"
    });
    expect(deps).toEqual([
      path.join(dataPath, "external-source-map2.map"),
      path.join(fixturesPath, "external-source-map2.txt")
    ]);
  });

  it("should use last SourceMap directive", async () => {
    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, "multi-source-map.js")
    );
    expect(warns).toHaveLength(0);
    expect(res).toEqual(
      'with SourceMap\nanInvalidDirective = "\\n/*# sourceMappingURL=data:application/json;base64,"+btoa(unescape(encodeURIComponent(JSON.stringify(sourceMap))))+" */";\n// comment'
    );
    expect(map).toEqual({
      version: 3,
      file: "inline-source-map.js",
      sources: [path.join(fixturesPath, "inline-source-map.txt")],
      sourcesContent: ["with SourceMap"],
      mappings: "AAAA"
    });
    expect(deps).toHaveLength(0);
  });

  it("should skip invalid base64 SourceMap", async () => {
    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, "invalid-inline-source-map.js")
    );
    expect(warns).toHaveLength(0);
    expect(res).toEqual(
      'without SourceMap\n// @sourceMappingURL=data:application/source-map;base64,"something invalid"\n// comment'
    );
    expect(map).toBeUndefined();
    expect(deps).toHaveLength(0);
  });
  it("should warn on invalid base64 SourceMap", async () => {
    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, "invalid-inline-source-map2.js")
    );
    expect(warns).toMatchObject([
      new RegExp(
        "Cannot parse inline SourceMap 'invalid/base64=': SyntaxError: Unexpected token"
      )
    ]);
    expect(res).toEqual(
      "without SourceMap\n// @sourceMappingURL=data:application/source-map;base64,invalid/base64=\n// comment"
    );
    expect(map).toBeUndefined();
    expect(deps).toHaveLength(0);
  });

  it("should warn on invalid SourceMap", async () => {
    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, "invalid-source-map.js")
    );
    expect(warns).toMatchObject([
      new RegExp(
        "Cannot parse SourceMap 'invalid-source-map.map': SyntaxError: Unexpected string in JSON at position 102"
      )
    ]);
    expect(res).toEqual(
      "with SourceMap\n//#sourceMappingURL=invalid-source-map.map\n// comment"
    );
    expect(map).toBeUndefined();
    expect(deps).toEqual([path.join(fixturesPath, "invalid-source-map.map")]);
  });

  it("should warn on missing SourceMap", async () => {
    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, "missing-source-map.js")
    );
    expect(warns).toMatchObject([
      new RegExp(
        `Cannot open SourceMap '${path.join(
          fixturesPath,
          "missing-source-map.map"
        )}':`
      )
    ]);
    expect(res).toEqual(
      "with SourceMap\n//#sourceMappingURL=missing-source-map.map\n// comment"
    );
    expect(map).toBeUndefined();
    expect(deps).toHaveLength(0);
  });

  it("should warn on missing source file", async () => {
    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, "missing-source-map2.js")
    );
    expect(warns).toMatchObject([
      new RegExp(
        `Cannot open source file '${path.join(
          fixturesPath,
          "missing-source-map2.txt"
        )}':`
      )
    ]);
    expect(res).toEqual("with SourceMap\n// comment");
    expect(map).toEqual({
      version: 3,
      file: "missing-source-map2.js",
      sources: [path.join(fixturesPath, "missing-source-map2.txt")],
      sourcesContent: [null],
      mappings: "AAAA"
    });
    expect(deps).toEqual([path.join(fixturesPath, "missing-source-map2.map")]);
  });

  it("should process inlined SourceMaps with charset", async () => {
    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, "charset-inline-source-map.js")
    );
    expect(warns).toHaveLength(0);
    expect(res).toEqual("with SourceMap\n// comment");
    expect(map).toEqual({
      version: 3,
      file: "charset-inline-source-map.js",
      sources: [path.join(fixturesPath, "charset-inline-source-map.txt")],
      sourcesContent: ["with SourceMap"],
      mappings: "AAAA"
    });
    expect(deps).toHaveLength(0);
  });

  it("should support absolute sourceRoot paths in sourcemaps", async () => {
    const sourceRoot = path.join(fixturesPath);
    const javaScriptFilename = "absolute-sourceRoot-source-map.js";
    const sourceFilename = "absolute-sourceRoot-source-map.txt";
    const rootRelativeSourcePath = path.join(sourceRoot, sourceFilename);
    const sourceMapPath = path.join(
      sourceRoot,
      "absolute-sourceRoot-source-map.map"
    );

    // Create the sourcemap file
    const rawSourceMap = {
      version: 3,
      file: javaScriptFilename,
      sourceRoot: sourceRoot,
      sources: [sourceFilename],
      mappings: "AAAA"
    };
    await fs.writeFile(sourceMapPath, JSON.stringify(rawSourceMap));

    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, javaScriptFilename)
    );
    expect(warns).toHaveLength(0);
    expect(res).toEqual("with SourceMap\n// comment");
    expect(map).toEqual({
      version: 3,
      file: javaScriptFilename,
      sources: [rootRelativeSourcePath],
      sourcesContent: ["with SourceMap\n// comment"],
      mappings: "AAAA"
    });
    expect(deps).toEqual([sourceMapPath, rootRelativeSourcePath]);
  });

  it("should support relative sourceRoot paths in sourcemaps", async () => {
    const javaScriptFilename = "relative-sourceRoot-source-map.js";
    const sourceFilename = "relative-sourceRoot-source-map.txt";
    const rootRelativeSourcePath = path.join(dataPath, sourceFilename);
    const sourceMapPath = path.join(
      fixturesPath,
      "relative-sourceRoot-source-map.map"
    );

    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, javaScriptFilename)
    );
    expect(warns).toHaveLength(0);
    expect(res).toEqual("with SourceMap\n// comment");
    expect(map).toEqual({
      version: 3,
      file: javaScriptFilename,
      sources: [rootRelativeSourcePath],
      sourcesContent: ["with SourceMap\n// comment"],
      mappings: "AAAA"
    });
    expect(deps).toEqual([sourceMapPath, rootRelativeSourcePath]);
  });

  it("should support null value in sourcesContent", async () => {
    const javaScriptFilename = "null-sourcesContent-source-map.js";
    const sourceFilename = "null-sourcesContent-source-map.txt";
    const rootRelativeSourcePath = path.join(fixturesPath, sourceFilename);
    const sourceMapPath = path.join(
      fixturesPath,
      "null-sourcesContent-source-map.map"
    );

    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, javaScriptFilename)
    );
    expect(warns).toHaveLength(0);
    expect(res).toEqual("with SourceMap\n");
    expect(map).toEqual({
      version: 3,
      file: javaScriptFilename,
      sources: [rootRelativeSourcePath],
      sourcesContent: ["with SourceMap"],
      mappings: "AAAA"
    });
    expect(deps).toEqual([sourceMapPath, rootRelativeSourcePath]);
  });

  it("should resolve relative sources path even with sourcesContent", async () => {
    const javaScriptFilename =
      "relative-sourceRoot-sourcesContent-source-map.js";
    const sourceFilename = "relative-sourceRoot-sourcesContent-source-map.txt";
    const rootRelativeSourcePath = path.join(dataPath, sourceFilename);
    const sourceMapPath = path.join(
      fixturesPath,
      "relative-sourceRoot-sourcesContent-source-map.map"
    );

    const { res, map, deps, warns } = await execLoader(
      path.join(fixturesPath, javaScriptFilename)
    );
    expect(warns).toHaveLength(0);
    expect(res).toEqual("with SourceMap\n");
    expect(map).toEqual({
      version: 3,
      file: javaScriptFilename,
      sources: [rootRelativeSourcePath],
      sourcesContent: ["with SourceMap"],
      mappings: "AAAA"
    });
    expect(deps).toEqual([sourceMapPath]);
  });
});
