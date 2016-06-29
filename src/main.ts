#!/usr/bin/env node

import * as fs from 'fs';
import * as minimist from 'minimist';
import * as mkdirp from 'mkdirp';
import * as path from 'path';
import * as ts from 'typescript';

import * as cliSupport from './cli_support';
import * as tsickle from './tsickle';

/** Tsickle settings passed on the command line. */
interface Settings {
  /** If provided, path to save externs to. */
  externsPath?: string;

  /** If provided, convert every type to the Closure {?} type */
  isUntyped: boolean;

  /** If true, log internal debug warnings to the console. */
  verbose?: boolean;

  /**
   * If true, do not error when types are found in comments. Useful for
   * building third party libraries which have types in comments.
   */
  ignoreTypesInComments: boolean;
}

function usage() {
  console.error(`usage: tsickle [tsickle options] -- [tsc options]

example:
  tsickle --externs=foo/externs.js -- -p src --noImplicitAny

tsickle flags are:
  --externs=PATH          save generated Closure externs.js to PATH
  --untyped               convert every type in TypeScript to the Closure {?} type
  --ignoreTypesInComments do not error when encountering any jsdoc type information in comments
`);
}

/**
 * Parses the command-line arguments, extracting the tsickle settings and
 * the arguments to pass on to tsc.
 */
function loadSettingsFromArgs(args: string[]): {settings: Settings, tscArgs: string[]} {
  let settings: Settings = {isUntyped: false, ignoreTypesInComments: false};
  let parsedArgs = minimist(args);
  for (let flag of Object.keys(parsedArgs)) {
    switch (flag) {
      case 'h':
      case 'help':
        usage();
        process.exit(0);
        break;
      case 'externs':
        settings.externsPath = parsedArgs[flag];
        break;
      case 'untyped':
        settings.isUntyped = true;
        break;
      case 'verbose':
        settings.verbose = true;
        break;
      case 'ignoreTypesInComments':
        settings.ignoreTypesInComments = true;
        break;
      case '_':
        // This is part of the minimist API, and holds args after the '--'.
        break;
      default:
        console.error(`unknown flag '--${flag}'`);
        usage();
        process.exit(1);
    }
  }
  // Arguments after the '--' arg are arguments to tsc.
  let tscArgs = parsedArgs['_'];
  return {settings, tscArgs};
}

/**
 * Loads the tsconfig.json from a directory.
 * Unfortunately there's a ton of logic in tsc.ts related to searching
 * for tsconfig.json etc. that we don't really want to replicate, e.g.
 * tsc appears to allow -p path/to/tsconfig.json while this only works
 * with -p path/to/containing/dir.
 *
 * @param args tsc command-line arguments.
 */
function loadTscConfig(args: string[]):
    {options?: ts.CompilerOptions, fileNames?: string[], errors?: ts.Diagnostic[]} {
  // Gather tsc options/input files from command line.
  let {options, fileNames, errors} = ts.parseCommandLine(args);
  if (errors.length > 0) {
    return {errors};
  }

  // Store file arguments
  let tsFileArguments = fileNames;

  // Read further settings from tsconfig.json.
  let projectDir = options.project || '.';
  let configFileName = path.join(projectDir, 'tsconfig.json');
  let {config: json, error} =
      ts.readConfigFile(configFileName, path => fs.readFileSync(path, 'utf-8'));
  if (error) {
    return {errors: [error]};
  }
  ({options, fileNames, errors} =
       ts.parseJsonConfigFileContent(json, ts.sys, projectDir, options, configFileName));
  if (errors.length > 0) {
    return {errors};
  }

  // if file arguments were given to the typescript transpiler than transpile only those files
  fileNames = tsFileArguments.length > 0 ? tsFileArguments : fileNames;

  return {options, fileNames};
}

/**
 * Constructs a new ts.CompilerHost that overlays sources in substituteSource
 * over another ts.CompilerHost.
 *
 * @param substituteSource A map of source file name -> overlay source text.
 */
function createSourceReplacingCompilerHost(
    substituteSource: ts.Map<string>, delegate: ts.CompilerHost): ts.CompilerHost {
  return {
    getSourceFile,
    getCancellationToken: delegate.getCancellationToken,
    getDefaultLibFileName: delegate.getDefaultLibFileName,
    writeFile: delegate.writeFile,
    getCurrentDirectory: delegate.getCurrentDirectory,
    getCanonicalFileName: delegate.getCanonicalFileName,
    useCaseSensitiveFileNames: delegate.useCaseSensitiveFileNames,
    getNewLine: delegate.getNewLine,
    fileExists: delegate.fileExists,
    readFile: delegate.readFile,
    directoryExists: delegate.directoryExists,
  };

  function getSourceFile(
      fileName: string, languageVersion: ts.ScriptTarget,
      onError?: (message: string) => void): ts.SourceFile {
    let sourceText: string;
    let path: string = ts.sys.resolvePath(fileName);
    if (substituteSource.hasOwnProperty(path)) {
      sourceText = substituteSource[path];
      return ts.createSourceFile(path, sourceText, languageVersion);
    }
    return delegate.getSourceFile(path, languageVersion, onError);
  }
}

/**
 * Compiles TypeScript code into Closure-compiler-ready JS.
 * Doesn't write any files to disk; all JS content is returned in a map.
 */
function toClosureJS(options: ts.CompilerOptions, fileNames: string[], settings: Settings):
    {jsFiles?: {[fileName: string]: string}, externs?: string, errors?: ts.Diagnostic[]} {
  // Parse and load the program without tsickle processing.
  // This is so:
  // - error messages point at the original source text
  // - tsickle can use the result of typechecking for annotation
  let program = ts.createProgram(fileNames, options);
  let errors = ts.getPreEmitDiagnostics(program);
  if (errors.length > 0) {
    return {errors};
  }

  const tsickleOptions: tsickle.Options = {
    untyped: settings.isUntyped,
    ignoreTypesInComments: settings.ignoreTypesInComments,
    logWarning: settings.verbose ?
        (warning: ts.Diagnostic) => { console.error(tsickle.formatDiagnostics([warning])); } :
        null,
  };

  // Process each input file with tsickle and save the output.
  let tsickleOutput: ts.Map<string> = {};
  let tsickleExterns = '';
  for (let fileName of fileNames) {
    let {output, externs, diagnostics} =
        tsickle.annotate(program, program.getSourceFile(fileName), tsickleOptions);
    if (diagnostics.length > 0) {
      return {errors: diagnostics};
    }
    tsickleOutput[ts.sys.resolvePath(fileName)] = output;
    if (externs) {
      tsickleExterns += externs;
    }
  }

  // Reparse and reload the program, inserting the tsickle output in
  // place of the original source.
  let host = createSourceReplacingCompilerHost(tsickleOutput, ts.createCompilerHost(options));
  program = ts.createProgram(fileNames, options, host);
  errors = ts.getPreEmitDiagnostics(program);
  if (errors.length > 0) {
    return {errors};
  }

  // Emit, creating a map of fileName => generated JS source.
  let jsFiles: {[fileName: string]: string} = {};
  function writeFile(fileName: string, data: string): void { jsFiles[fileName] = data; }
  let {diagnostics} = program.emit(undefined, writeFile);
  if (diagnostics.length > 0) {
    return {errors: diagnostics};
  }

  for (let fileName of Object.keys(jsFiles)) {
    if (path.extname(fileName) !== '.map') {
      let {output} = tsickle.convertCommonJsToGoogModule(
          fileName, jsFiles[fileName], cliSupport.pathToModuleName);
      jsFiles[fileName] = output;
    }
  }

  return {jsFiles, externs: tsickleExterns};
}

function main(args: string[]) {
  let {settings, tscArgs} = loadSettingsFromArgs(args);
  let {options, fileNames, errors} = loadTscConfig(tscArgs);
  if (errors && errors.length > 0) {
    console.error(tsickle.formatDiagnostics(errors));
    process.exit(1);
  }

  // Run tsickle+TSC to convert inputs to Closure JS files.
  let jsFiles: {[fileName: string]: string};
  let externs: string;
  ({jsFiles, externs, errors} = toClosureJS(options, fileNames, settings));
  if (errors && errors.length > 0) {
    console.error(tsickle.formatDiagnostics(errors));
    process.exit(1);
  }

  for (let fileName of Object.keys(jsFiles)) {
    mkdirp.sync(path.dirname(fileName));
    fs.writeFileSync(fileName, jsFiles[fileName]);
  }

  if (settings.externsPath) {
    mkdirp.sync(path.dirname(settings.externsPath));
    fs.writeFileSync(settings.externsPath, externs);
  }
}

// CLI entry point
if (require.main === module) {
  main(process.argv.splice(2));
}
