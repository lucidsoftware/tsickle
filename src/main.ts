#!/usr/bin/env node

/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as fs from 'fs';
import * as minimist from 'minimist';
import * as mkdirp from 'mkdirp';
import * as path from 'path';
import * as ts from 'typescript';

import * as cliSupport from './cli_support';
import * as tsickle from './tsickle';
import {processES5} from './es5processor';
import {toArray, createOutputRetainingCompilerHost, createSourceReplacingCompilerHost} from './util';
/** Tsickle settings passed on the command line. */
export interface Settings {
  /** If provided, path to save externs to. */
  externsPath?: string;

  /** If provided, attempt to provide types rather than {?}. */
  isTyped?: boolean;

  /** If true, log internal debug warnings to the console. */
  verbose?: boolean;

  /** If true, transpile only rather than type check and annotate */
  devMode?: boolean;

  googModuleRegexes: Array<[RegExp, string]>;
}

export interface SettingsKeys {
  'externs'?: string;
  'typed'?: boolean;
  'typedSignatures'?: boolean;
  'verbose'?: boolean;
  'devmode'?: boolean;
  'googModuleRegexes'?: Array<[string, string]>;
}

function usage() {
  console.error(`usage: tsickle [tsickle options] -- [tsc options]

example:
  tsickle --externs=foo/externs.js -- -p src --noImplicitAny

tsickle flags are:
  --externs=PATH     save generated Closure externs.js to PATH
  --typed            [experimental] attempt to provide Closure types instead of {?}
`);
}

function tsNameToJsName(tsName: string, options: ts.CompilerOptions) {
  if (options.outDir) {
    let rootDir = ts.sys.resolvePath(process.cwd());
    let absPath = ts.sys.resolvePath(tsName);
    let relativePath = path.relative(rootDir, absPath);

    return options.outDir + '/' + relativePath.replace(/\.ts$/, '.js');
  } else {
    return tsName.replace(/\.ts$/, '.js');
  }
}

/**
 * Parses the command-line arguments, extracting the tsickle settings and
 * the arguments to pass on to tsc.
 */
function loadSettingsFromArgs(args: string[]): {settings: Settings, tscArgs: string[]} {
  const settings: Settings = {googModuleRegexes: []};
  const parsedArgs = minimist(args);
  for (const flag of Object.keys(parsedArgs)) {
    switch (flag) {
      case 'h':
      case 'help':
        usage();
        process.exit(0);
        break;
      case 'devmode':
        settings.devMode = true;
        break;
      case 'externs':
        settings.externsPath = parsedArgs[flag];
        break;
      case 'typed':
        settings.isTyped = true;
        break;
      case 'verbose':
        settings.verbose = true;
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
  const tscArgs = parsedArgs['_'];
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
function loadTscConfig(args: string[], allDiagnostics: ts.Diagnostic[]):
    {options: ts.CompilerOptions, fileNames: string[], tsickleSettings: SettingsKeys}|null {
  // Gather tsc options/input files from command line.
  // Bypass visibilty of parseCommandLine, see
  // https://github.com/Microsoft/TypeScript/issues/2620
  // tslint:disable-next-line:no-any
  let {options, fileNames, errors} = (ts as any).parseCommandLine(args);
  if (errors.length > 0) {
    allDiagnostics.push(...errors);
    return null;
  }

  // Store file arguments
  const tsFileArguments = fileNames;

  // Read further settings from tsconfig.json.
  const projectDir = options.project || '.';
  const configFileName = path.join(projectDir, 'tsconfig.json');
  const {config: json, error} =
      ts.readConfigFile(configFileName, path => fs.readFileSync(path, 'utf-8'));
  if (error) {
    allDiagnostics.push(error);
    return null;
  }
  let tsickleSettings = {};
  if (json.tsickle) {
    tsickleSettings = json.tsickle;
  }
  ({options, fileNames, errors} =
       ts.parseJsonConfigFileContent(json, ts.sys, projectDir, options, configFileName));
  if (errors.length > 0) {
    allDiagnostics.push(...errors);
    return null;
  }

  // if file arguments were given to the typescript transpiler than transpile only those files
  fileNames = tsFileArguments.length > 0 ? tsFileArguments : fileNames;

  return {options, fileNames, tsickleSettings};
}

export interface ClosureJSOptions {
  tsickleCompilerHostOptions: tsickle.Options;
  tsickleHost: tsickle.TsickleHost;
  files: Map<string, string>;
  tsicklePasses: tsickle.Pass[];
}

function getDefaultClosureJSOptions(fileNames: string[], settings: Settings, options: ts.CompilerOptions): ClosureJSOptions {
  return {
    tsickleCompilerHostOptions: {
      googmodule: true,
      es5Mode: false,
      untyped: !settings.isTyped,
    },
    tsickleHost: {
      shouldSkipTsickleProcessing: (fileName) => fileNames.indexOf(fileName) === -1,
      pathToModuleName: (context, fileName) => {
        return settings.googModuleRegexes.reduce(
          (moduleName, regex) => moduleName.replace(regex[0], regex[1]),
          cliSupport.pathToModuleName(context, fileName)
        );
      },
      shouldIgnoreWarningsForPath: (filePath) => false,
      fileNameToModuleId: (fileName) => fileName,
    },
    files: new Map<string, string>(),
    tsicklePasses: [tsickle.Pass.CLOSURIZE],
  };
}

function toClosureJSDevMode(options: ts.CompilerOptions, fileNames: string[], settings: Settings, allDiagnostics: ts.Diagnostic[]):
    {jsFiles: Map<string, string>, externs: string}|null {
  let rootDir = ts.sys.resolvePath(process.cwd());
  let jsFiles: Map<string, string> = new Map<string, string>();
  fileNames.forEach(function(tsName) {
   if (tsName.substr(-5) != '.d.ts') {
      let jsName = tsNameToJsName(tsName, options);
      let code = fs.readFileSync(tsName, {encoding: 'utf-8'});

      let result = ts.transpileModule(code, {
        compilerOptions: options,
        fileName: tsName,
        reportDiagnostics: true,
        moduleName: tsName,
      });

      allDiagnostics.push.apply(allDiagnostics, result.diagnostics);

      let absPath = ts.sys.resolvePath(jsName);
      let relativePath = path.relative(rootDir, absPath);

      let es5ProcessorHost = {
          pathToModuleName: (context: string, fileName: string) => {
          return settings.googModuleRegexes.reduce(
            (moduleName, regex) => moduleName.replace(regex[0], regex[1]),
            cliSupport.pathToModuleName(context, fileName)
          );
        },
        fileNameToModuleId: (fileName: string) => fileName,
      };
      let {output} = processES5(es5ProcessorHost, {}, relativePath, result.outputText);
      jsFiles.set(jsName, output);
    }
  });
  return {jsFiles, externs: ''};
}

/**
 * Compiles TypeScript code into Closure-compiler-ready JS.
 * Doesn't write any files to disk; all JS content is returned in a map.
 */
export function toClosureJS(
    options: ts.CompilerOptions, fileNames: string[], settings: Settings,
    allDiagnostics: ts.Diagnostic[], partialClosureJSOptions = {} as Partial<ClosureJSOptions>):
    {jsFiles: Map<string, string>, externs: string}|null {
  const closureJSOptions: ClosureJSOptions = {
    ...getDefaultClosureJSOptions(fileNames, settings, options),
    ...partialClosureJSOptions
  };
  // Parse and load the program without tsickle processing.
  // This is so:
  // - error messages point at the original source text
  // - tsickle can use the result of typechecking for annotation
  const jsFiles = new Map<string, string>();
  const outputRetainingHost =
      createOutputRetainingCompilerHost(jsFiles, ts.createCompilerHost(options));

  const sourceReplacingHost =
      createSourceReplacingCompilerHost(closureJSOptions.files, outputRetainingHost);

  const tch = new tsickle.TsickleCompilerHost(
      sourceReplacingHost, options, closureJSOptions.tsickleCompilerHostOptions,
      closureJSOptions.tsickleHost);

  let program = ts.createProgram(fileNames, options, tch);
  {  // Scope for the "diagnostics" variable so we can use the name again later.
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      allDiagnostics.push(...diagnostics);
      return null;
    }
  }

  // Reparse and reload the program, inserting the tsickle output in
  // place of the original source.
  if (closureJSOptions.tsicklePasses.indexOf(tsickle.Pass.DECORATOR_DOWNLEVEL) !== -1) {
    tch.reconfigureForRun(program, tsickle.Pass.DECORATOR_DOWNLEVEL);
    program = ts.createProgram(fileNames, options, tch);
  }

  if (closureJSOptions.tsicklePasses.indexOf(tsickle.Pass.CLOSURIZE) !== -1) {
    tch.reconfigureForRun(program, tsickle.Pass.CLOSURIZE);
    program = ts.createProgram(fileNames, options, tch);
  }

  const {diagnostics} = program.emit(undefined);
  if (diagnostics.length > 0) {
    allDiagnostics.push(...diagnostics);
    return null;
  }

  return {jsFiles, externs: tch.getGeneratedExterns()};
}

function main(args: string[]): number {
  const {settings, tscArgs} = loadSettingsFromArgs(args);
  const diagnostics: ts.Diagnostic[] = [];
  const config = loadTscConfig(tscArgs, diagnostics);
  if (config === null) {
    console.error(tsickle.formatDiagnostics(diagnostics));
    return 1;
  }

  if (config.options.module !== ts.ModuleKind.CommonJS) {
    // This is not an upstream TypeScript diagnostic, therefore it does not go
    // through the diagnostics array mechanism.
    console.error(
        'tsickle converts TypeScript modules to Closure modules via CommonJS internally. Set tsconfig.js "module": "commonjs"');
    return 1;
  }

  // Run tsickle+TSC to convert inputs to Closure JS files.
  for (let tsickleSettingsKey in config.tsickleSettings) {
    switch (tsickleSettingsKey) {
      case 'devmode':
        settings.devMode = true;
        break;
      case 'externs':
        if (!settings.hasOwnProperty('externsPath')) {
          settings.externsPath = config.tsickleSettings.externs;
        }
        break;
      case 'typed':
        if (!settings.hasOwnProperty('isTyped')) {
          settings.isTyped = config.tsickleSettings.typed || false;
        }
        break;
      case 'verbose':
        if (!settings.hasOwnProperty('verbose')) {
          settings.verbose = config.tsickleSettings.verbose;
        }
        break;
      case 'googModuleRegexes':
        settings.googModuleRegexes = (config.tsickleSettings.googModuleRegexes || []).map(([a, b]) => [new RegExp(a), b] as [RegExp, string]);
        break;
    }
  }

  const closure = settings.devMode
    ? toClosureJSDevMode(config.options, config.fileNames, settings, diagnostics)
    : toClosureJS(config.options, config.fileNames, settings, diagnostics);
  if (closure === null) {
    console.error(tsickle.formatDiagnostics(diagnostics));
    return 1;
  }

  for (const fileName of toArray(closure.jsFiles.keys())) {
    mkdirp.sync(path.dirname(fileName));
    let src = closure.jsFiles.get(fileName);
    fs.writeFileSync(fileName, src);
  }

  if (settings.externsPath) {
    mkdirp.sync(path.dirname(settings.externsPath));
    fs.writeFileSync(settings.externsPath, closure.externs);
  }
  return 0;
}

// CLI entry point
if (require.main === module) {
  process.exit(main(process.argv.splice(2)));
}
