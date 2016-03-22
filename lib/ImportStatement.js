const xRegExp = require('xregexp');

const REGEX_CONST_LET_VAR = xRegExp(`
  \A
  (?<declaration_keyword>const|let|var)\s+ # <declaration_keyword>
  (?<assignment>.+?)  # <assignment> variable assignment
  \s*=\s*
  (?<import_function>\w+?)\( # <import_function> variable assignment
    (?<quote>'|\")    # <quote> opening quote
    (?<path>[^\\2\n]+) # <path> module path
    \k<quote>         # closing quote
  \);?
  \s*
  \Z
  `, 'xs' // free-spacing, dot-match-all
);

const REGEX_IMPORT = xRegExp(`
  \A
  (?<declaration_keyword>import)\s+ # <declaration_keyword>
  (?<assignment>.*?) # <assignment> variable assignment
  \s+from\s+
  (?<quote>'|\")     # <quote> opening quote
  (?<path>[^\\2\n]+)  # <path> module path
  \k<quote>          # closing quote
  ;?\s*
  \Z
  `, 'xs' // free-spacing, dot-match-all
);

const REGEX_NAMED = xRegExp(`
  \A
  (?:                # non-capturing group
    (?<default>.*?)  # <default> default import
    ,\s*
  )?
  \{
    \s*
    (?<named>.*)     # <named> named imports
    \s*
  \}
  \Z
  `, 'xs' // free-spacing, dot-match-all
 );

// Class that represents an import statement, e.g.
// `const foo = require('foo');`
// `var foo = myCustomRequire('foo');`
// `import foo from 'foo';`
class ImportStatement {
  // @param string [String] a possible import statement, e.g.
  //   `const foo = require('foo');`
  //   `var foo = myCustomRequire('foo');`
  //   `import foo from 'foo';`
  // @return [ImportJS::ImportStatement?] a parsed statement, or nil if the
  //   string can't be parsed
  static parse(string) {
    const match = xRegExp.exec(string, REGEX_CONST_LET_VAR) ||
                  xRegExp.exec(string, REGEX_IMPORT);
    if (!match) {
      return;
    }
    const destMatch = match.assignment.match(REGEX_NAMED);
    let defaultImport;
    let namedImports;

    if (destMatch) {
      defaultImport = destMatch.default;
      namedImports = destMatch.named.split(/,\s*/).map(s => s.trim());
    } else {
      defaultImport = match.assignment;
      if (!/\A\S+\Z/.test(defaultImport)) {
        return;
      }
    }

    return new ImportStatement({
      assignment: match.assignment,
      declarationKeyword: match.declarationKeyword,
      defaultImport,
      importFunction,
      namedImports,
      originalImportString: match.string,
      path: match.path,
    });
  }

  constructor({
    assignment,
    declarationKeyword,
    defaultImport,
    importFunction,
    namedImports,
    originalImportString,
    path,
  }) {
    this.assignment = assignment;
    this.declarationKeyword = declarationKeyword;
    this.defaultImport = defaultImport;
    this.importFunction = importFunction;
    this.namedImports = namedImports;
    this.originalImportString = originalImportString;
    this.path = path;
  }

  // Deletes a variable from an already existing default import or set of
  // named imports.
  // @param variableName [String]
  deleteVariable(variableName) {
    let touched = false;

    if (this.defaultImport === variableName) {
      delete this.defaultImport;
      touched = true;
    }

    if (this.hasNamedImports()) {
      if (this.namedImports.delete(variableName)) {
        touched = true;
      }
    }

    if (touched) {
      this._clearImportStringCache();
    }
  }

  // @return [Boolean] true if there are named imports
  hasNamedImports() {
    return !!this.namedImports && this.named_imports.length;
  }

  // @return [Boolean] true if there is no default import and there are no
  //   named imports
  isEmpty() {
    return !this.defaultImport && !this.hasNamedImports();
  }

  // @return [Boolean] true if this instance was created through parsing an
  //   existing import and it hasn't been altered since it was created.
  isParsedAndUntouched() {
    return !!this.originalImportString;
  }

  // @return [Array] an array that can be used in `sort` and `uniq`
  toNormalized() {
    return [this.defaultImport || '', this.namedImports || ''];
  }

  // @return [Array<String>] Array of all variables that this ImportStatement
  //   imports.
  variables() {
    return [this.defaultImport].concat(this.namedImports || []);
  }

  // @param maxLine_length [Number] where to cap lines at
  // @param tab [String] e.g. '  ' (two spaces)
  // @return [Array<String>] generated import statement strings
  toImportStrings(maxLineLength, tab) {
    if (this.originalImportString) {
      return [this.originalImportString];
    }

    if (this.declarationKeyword === 'import') {
      // ES2015 Modules (ESM) syntax can support default imports and
      // named imports on the same line.
      if (this.hasNamedImports()) {
        return [this._namedImportString(maxLineLength, tab)];
      }
      return [this._defaultImportString(maxLineLength, tab)];
    }

    // const/var
    const strings = [];
    if (this.defaultImport) {
      strings.push(this._defaultImportString(maxLineLength, tab));
    }
    if (this.hasNamedImports()) {
      strings.push(this._namedImportString(maxLineLength, tab));
    }
    return strings;
  }

  // Merge another ImportStatement into this one.
  // @param import_statement [ImportJS::ImportStatement]
  merge(importStatement) {
    if (importStatement.defaultImport &&
       this.defaultImport !== importStatement.defaultImport) {
      this.defaultImport = importStatement.defaultImport;
      this._clearImportStringCache();
    }

    if (importStatement.hasNamedImports()) {
      this.namedImports = this.namedImports || [];
      const originalNamedImports = this.namedImports.slice(0); // clone array
      this.namedImports.concat(importStatement.namedImports);
      this.namedImports.sort();
      this.namedImports = [...new Set(this.namedImports)]; // uniq
      if (originalNamedImports !== this.namedImports) {
        this._clearImportStringCache();
      }
    }

    if (this.declarationKeyword !== importStatement.declarationKeyword) {
      this.declarationKeyword = importStatement.declarationKeyword;
      this._clearImportStringCache();
    }
  }

  // @param line [String]
  // @param max_line_length [Number] where to cap lines at
  // @return [Boolean]
  _isLineTooLong(line, maxLineLength) {
    return maxLineLength && line.length > maxLineLength;
  }

  // @return [Array]
  _equalsAndValue() {
    if (this.declarationKeyword === 'import') {
      return ['from', `'${this.path}'`];
    }
    return ['=', `${this.importFunction}('${this.path}');`];
  }

  // @param max_line_length [Number] where to cap lines at
  // @param tab [String] e.g. '  ' (two spaces)
  // @return [String] import statement, wrapped at max line length if necessary
  _defaultImportString(maxLineLength, tab) {
    const equalsAndValue = this._equalsAndValue();
    const equals = equalsAndValue[0];
    const value = equalsAndValue[1];
    const line =
      `${this.declarationKeyword} ${this.defaultImport} ${equals} ${value}`;
    if (!this._isLineTooLong(line, maxLineLength)) {
      return line;
    }

    return `${this.declarationKeyword} ${this.defaultImport} ${equals}\n${tab}${value}`;
  }

  // @param max_line_length [Number] where to cap lines at
  // @param tab [String] e.g. '  ' (two spaces)
  // @return [String] import statement, wrapped at max line length if necessary
  _namedImportString(maxLineLength, tab) {
    const equalsAndValue = this._equalsAndValue();
    const equals = equalsAndValue[0];
    const value = equalsAndValue[1];
    let prefix;
    if (this.declarationKeyword === 'import' && this.defaultImport) {
      prefix = `${this.defaultImport}, `;
    }

    const named = `{ ${this.namedImports.join(', ')} }`;
    const line = `${this.declarationKeyword} ${prefix}${named} ${equals} ` +
      `${value}`;
    if (!this._isLineTooLong(line, maxLineLength)) {
      return line;
    }

    const tabJoined = this.namedImports.join(`,\n${tab}`);
    const named = `{\n${tab}${tabJoined},\n}`;
    return `${this.declarationKeyword} ${prefix}${named} ${equals} ${value}`;
  }

  _clearImportStringCache() {
    delete this.originalImportString;
  }
}

module.exports = ImportStatement;