const xml = require('xml');
const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const md5 = require('md5');
const stripAnsi = require('strip-ansi');

const INVALID_CHARACTERS = ['\u001b'];

function parsePropertiesFromEnv(envValue) {
  let properties = null;

  if (envValue) {
    properties = {};
    const propertiesArray = envValue.split(',');
    for (let i = 0; i < propertiesArray.length; i++) {
      const propertyArgs = propertiesArray[i].split(':');
      properties[propertyArgs[0]] = propertyArgs[1];
    }
  }

  return properties;
}

function lastSuite(testsuites) {
  return testsuites[testsuites.length - 1].testsuite;
}

function removeInvalidCharacters(input) {
  return INVALID_CHARACTERS.reduce(function (text, invalidCharacter) {
    return text.replace(new RegExp(invalidCharacter, 'g'), '');
  }, input);
}

function getTestcaseData(test, err, options) {
  const flipClassAndName = options.testCaseSwitchClassnameAndName;
  const name = stripAnsi(test.title[1]);
  const classname = stripAnsi(test.title[0]);
  const config = {
    testcase: [{
      _attr: {
        name: flipClassAndName ? classname : name,
        time: test.timings.wallClockDuration,
        classname: flipClassAndName ? name : classname
      }
    }]
  };

  if (err) {
    config.testcase.push({failure: {
        _attr: {
          message: err
        },
        _cdata: removeInvalidCharacters(err)
      }});
  }
  return config;
}

function fullSuiteTitle(suite, options) {
  let parent = suite.parent;
  const title = [suite.title];

  while (parent) {
    if (parent.root && parent.title === '') {
      title.unshift(options.rootSuiteTitle);
    } else {
      title.unshift(parent.title);
    }
    parent = parent.parent;
  }

  return stripAnsi(title.join(options.suiteTitleSeparatedBy));
}

function generateProperties(options) {
  const properties = [];
  for (let propertyName in options.properties) {
    if (options.properties.hasOwnProperty(propertyName)) {
      properties.push({
        property: {
          _attr: {
            name: propertyName,
            value: options.properties[propertyName]
          }
        }
      });
    }
  }
  return properties;
}

function defaultSuiteTitle(suite, options) {
  if (suite.root && suite.title === '') {
    return stripAnsi(options.rootSuiteTitle);
  }
  return stripAnsi(suite.title);
}

function getTestsuiteData(suite, options) {
  const testSuite = {
    testsuite: [
      {
        _attr: {
          name: options.useFullSuiteTitle ? fullSuiteTitle(suite) : defaultSuiteTitle(suite),
          timestamp: new Date().toISOString().slice(0, -5),
          tests: suite.tests.length
        }
      }
    ]
  };

  if (suite.file) {
    testSuite.testsuite[0]._attr.file = suite.file;
  }

  const properties = generateProperties(options);
  if (properties.length) {
    testSuite.testsuite.push({
      properties: properties
    });
  }

  return testSuite;
}

function getXml(cypressReport, junitSuites, options) {
  let totalSuitesTime = cypressReport.totalDuration;
  let totalTests = cypressReport.totalTests;

  junitSuites.forEach(function(suite, index) {
    const _suiteAttr = suite.testsuite[0]._attr;
    // properties are added before test cases so we want to make sure that we are grabbing test cases
    // at the correct index
    let cypressRun = cypressReport.runs[index];

    _suiteAttr.failures = cypressRun.stats.failures;
    _suiteAttr.time = cypressRun.stats.wallClockDuration;
    _suiteAttr.skipped = cypressRun.stats.pending;

    if (!_suiteAttr.skipped) {
      delete _suiteAttr.skipped;
    }
  });

  const rootSuite = {
    _attr: {
      name: options.testsuitesTitle,
      time: totalSuitesTime,
      tests: totalTests,
      failures: cypressReport.totalFailed
    }
  };

  if (stats.pending) {
    rootSuite._attr.skipped = cypressReport.totalPending;
  }

  return xml({
    testsuites: [ rootSuite ].concat(junitSuites)
  }, { declaration: true, indent: '  ' });
}

function writeXmlToDisk(xml, filePath) {
  if (filePath) {
    if (filePath.indexOf('[hash]') !== -1) {
      filePath = filePath.replace('[hash]', md5(xml));
    }

    console.debug('writing file to', filePath);
    mkdirp.sync(path.dirname(filePath));

    try {
      fs.writeFileSync(filePath, xml, 'utf-8');
    } catch (exc) {
      console.debug('problem writing results: ' + exc);
    }
    console.debug('results written successfully');
  }
}

function flush(cypressReport, junitSuites, options) {
  const xml = getXml(junitSuites);

  writeXmlToDisk(xml, options.mochaFile);

  if (options.toConsole === true) {
    console.log(xml); // eslint-disable-line no-console
  }
}

module.exports = class {

  constructor(options) {
    this._options = options || {};
    this._options.mochaFile = options.mochaFile || process.env.MOCHA_FILE || 'test-results.xml';
    this._options.properties = options.properties || parsePropertiesFromEnv(process.env.PROPERTIES) || null;
    this._options.toConsole = !!options.toConsole;
    this._options.testCaseSwitchClassnameAndName = options.testCaseSwitchClassnameAndName || false;
    this._options.suiteTitleSeparedBy = options.suiteTitleSeparedBy || ' ';
    this._options.suiteTitleSeparatedBy = options.suiteTitleSeparatedBy || options.suiteTitleSeparedBy || ' ';
    this._options.rootSuiteTitle = options.rootSuiteTitle || 'Root Suite';
    this._options.testsuitesTitle = options.testsuitesTitle || 'Mocha Tests';
  }

  generate = function (cypressReport) {
    const junitSuites = [];

    if (fs.existsSync(this._options.mochaFile)) {
      debug('removing report file', this._options.mochaFile);
      fs.unlinkSync(this._options.mochaFile);
    }

    cypressReport.forEach((suite) => {
      junitSuites.push(getTestsuiteData(suite, this._options));

      suite.tests.forEach((test) => {
        if (test.state === 'passed') {
          lastSuite(junitSuites).push(getTestcaseData(test));
        }
        else if (test.state === 'pending') {
          const testcase = getTestcaseData(test);

          testcase.testcase.push({ skipped: null });
          lastSuite(junitSuites).push(testcase);
        }
        else if (test.state === 'failed') {
          lastSuite(junitSuites).push(getTestcaseData(test, test.error));
        }
      });
    });

    flush(cypressReport, junitSuites, this._options);
  };
};
