'use strict';

var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var string = require('string');
var yaml = require('js-yaml');
var colors = require('colors');
var childProcess = require('child_process');
var mkdirp = require('mkdirp');
var path = require('path');
var moment = require('moment');
var _ = require('underscore');
var Queue = require('promise-queue');

function getCurrentDateTime() {
  return moment().format('HH:mm:ss');
}

function printMsg(msg) {
  console.log(`[${getCurrentDateTime()}]`, msg);
}

function printErrorMsg(msg) {
  console.log(`[${getCurrentDateTime()}]`, colors.red('[ERROR]'), msg);
}

var config = yaml.safeLoad(fs.readFileSync('convert.yml', 'utf8'));

var srcDirectory = path.resolve(config.srcDirectory || './complete');
var dstDirectory = path.resolve(config.dstDirectory || './converted');
var dirScanInterval = config.dirScanInterval || 300;
var maxConcur = config.maxConcur || 1;

Queue.configure(Promise.Promise);

var queue = new Queue(maxConcur, Infinity);

mkdirp.sync(srcDirectory);
mkdirp.sync(dstDirectory);

function getFiles() {
  return fs
    .readdirAsync(srcDirectory)
    .then(files => _.filter(files, file => string(file).endsWith('.ts') || string(file).endsWith('.flv')));
}

function getTsSpawnArguments(srcFile, dstFile) {
  return [
    '-i',
    srcDirectory + '/' + srcFile,
    '-y',
    '-hide_banner',
    '-loglevel',
    'panic',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-bsf:a',
    'aac_adtstoasc',
    '-copyts',
    dstDirectory + '/~' + dstFile
  ];
}

function getFlvSpawnArguments(srcFile, dstFile) {
  return [
    '-i',
    srcDirectory + '/' + srcFile,
    '-y',
    '-hide_banner',
    '-loglevel',
    'panic',
    '-movflags',
    '+faststart',
    '-c:v',
    'copy',
    '-strict',
    '-2',
    '-q:a',
    '100',
    dstDirectory + '/~' + dstFile
  ];
}

function convertFile(srcFile) {
  return new Promise((resolve, reject) => {
    var dstFile;
    var spawnArguments;
    var startTs = moment();

    if (string(srcFile).endsWith('.ts')) {
      dstFile = string(srcFile).chompRight('ts').s + 'mp4';
      spawnArguments = getTsSpawnArguments(srcFile, dstFile);
    } else {
      dstFile = string(srcFile).chompRight('flv').s + 'mp4';
      spawnArguments = getFlvSpawnArguments(srcFile, dstFile);
    }

    printMsg(`Starting ${colors.green(srcFile)}...`);

    var convertProcess = childProcess.spawn('ffmpeg', spawnArguments);

    convertProcess.on('close', status => {
      if (status !== 0) {
        reject(`Failed to convert ${srcFile}`);
      } else {
        Promise.try(() => {
          return config.deleteAfter
            ? fs.unlinkAsync(srcDirectory + '/' + srcFile)
            : fs.renameAsync(srcDirectory + '/' + srcFile, srcDirectory + '/' + srcFile + '.bak');
        })
        .then(() => {
          fs.renameAsync(dstDirectory + '/~' + dstFile, dstDirectory + '/' + dstFile);
        })
        .then(() => {
          let duration = moment.duration(moment().diff(startTs)).asSeconds().toString() + ' s';

          printMsg(`Finished ${colors.green(srcFile)} after ${colors.magenta(duration)}`);

          resolve(srcFile);
        })
        .catch(err => {
          reject(err.toString());
        });
      }
    });
  });
}

function mainLoop() {
  var startTs = moment().unix();

  Promise
    .try(() => getFiles())
    .then(files => new Promise((resolve, reject) => {
      printMsg(files.length + ' file(s) to convert');

      if (files.length === 0) {
        resolve();
      } else {
        _.each(files, file => {
          queue
            .add(() => convertFile(file))
            .then(() => {
              if ((queue.getPendingLength() + queue.getQueueLength()) === 0) {
                resolve();
              }
            })
            .catch(err => {
              printErrorMsg(err);

              // reject(); // ???
            });
        });
      }
    }))
    .catch(err => {
      if (err) {
        printErrorMsg(err);
      }
    })
    .finally(() => {
      var seconds = startTs - moment().unix() + dirScanInterval;

      if (seconds < 5) {
        seconds = 5;
      }

      printMsg('Done, will scan the folder in ' + seconds + ' seconds.');

      setTimeout(mainLoop, seconds * 1000);
    });
}

mainLoop();
