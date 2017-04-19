'use strict';
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var mv = require('mv');
var yaml = require('js-yaml');
var moment = require('moment');
var mkdirp = require('mkdirp');
var S = require('string');
var WebSocketClient = require('websocket').client;
var bhttp = require('bhttp');
var colors = require('colors');
var _ = require('underscore');
var childProcess = require('child_process');
var path = require('path');
var HttpDispatcher = require('httpdispatcher');
var http = require('http');
var dispatcher = new HttpDispatcher();

function getCurrentDateTime() {
  return moment().format('YYYY-MM-DD_HH-mm-ss'); // The only true way of writing out dates and times, ISO 8601
};

function printMsg(msg) {
  console.log(colors.blue('[' + getCurrentDateTime() + ']'), msg);
}

function printErrorMsg(msg) {
  console.log(colors.blue('[' + getCurrentDateTime() + ']'), colors.red('[ERROR]'), msg);
}

function printDebugMsg(msg) {
  if (config.debug && msg) {
    console.log(colors.blue('[' + getCurrentDateTime() + ']'), colors.yellow('[DEBUG]'), msg);
  }
}

function getTimestamp() {
  return Math.floor(new Date().getTime() / 1000);
}

function dumpModelsCurrentlyCapturing() {
  _.each(modelsCurrentlyCapturing, function(m) {
    printDebugMsg(colors.red(m.pid) + '\t' + m.checkAfter + '\t' + m.filename + '\t' + m.size + ' bytes');
  });
}

function getUid(nm) {
  var onlineModel = _.findWhere(onlineModels, {nm: nm});

  return _.isUndefined(onlineModel) ? false : onlineModel.uid;
}

function remove(value, array) {
  var idx = array.indexOf(value);

  if (idx != -1) {
    array.splice(idx, 1);
  }
}

// returns true, if the mode has been changed
function setMode(uid, mode) {
  var configModel = _.findWhere(config.models, {uid: uid});

  if (_.isUndefined(configModel)) {
    config.models.push({uid: uid, mode: mode});

    return true;
  } else if (configModel.mode != mode) {
    configModel.mode = mode;

    return true;
  }

  return false;
}

function getFileno() {
  return new Promise(function(resolve, reject) {
    var client = new WebSocketClient();

    client.on('connectFailed', function(err) {
      reject(err);
    });

    client.on('connect', function(connection) {

      connection.on('error', function(err) {
        reject(err);
      });

      connection.on('message', function(message) {
        if (message.type === 'utf8') {
          var parts = /%22opts%22:([0-9_]*),%22respkey%22:([0-9_]*),%22serv%22:([0-9_]*),%22type%22:([0-9_]*)\}/.exec(message.utf8Data);

          if (parts && parts[1] && parts[2] && parts[3] && parts[4]) {
            var a = `respkey=${parts[2]}&type=${parts[4]}&opts=${parts[1]}&serv=${parts[3]}&`;
            printDebugMsg(a);

            connection.close();
            resolve(a);
          }
        }
      });

      connection.sendUTF("hello fcserver\n\0");
      connection.sendUTF("1 0 0 20071025 0 guest:guest\n\0");
    });

    client.connect('ws://xchat20.myfreecams.com:8080/fcsl', '', 'http://xchat20.myfreecams.com:8080', {Cookie: 'company_id=3149; guest_welcome=1; history=7411522,5375294'});
  }).timeout(30000); // 30 secs
}

function getOnlineModels(fileno) {
  var url = 'http://www.myfreecams.com/php/FcwExtResp.php?' + fileno;

  printDebugMsg(url);

  return Promise
    .try(function() {
      return session.get(url);
    })
    .then(function(response) {
      onlineModels = [];

      try {
        var data = JSON.parse(response.body.toString('utf8'));
        var m;

        for (var i = 1; i < data.rdata.length; i += 1) {
          m = data.rdata[i];

          onlineModels.push({
            m: {
              camscore: m[14],
              missmfc: 0,
              new_model: m[17],
              rc: m[19]
            },
            nm: m[0],
            u: {
              age: '',
              camserv: m[6],
              city: '',
              country: ''
            },
            uid: m[2],
            vs: m[3]
          });
        }
      } catch (err) {
        throw new Error('Failed to parse data');
      }

      printMsg(onlineModels.length  + ' model(s) online');
    })
    .timeout(30000); // 30 secs
}

function selectMyModels() {
  return Promise
    .try(function() {
      printDebugMsg(config.models.length + ' model(s) in config');

      // to include the model only knowing her name, we need to know her uid,
      // if we could not find model's uid in array of online models we skip this model till the next iteration
      config.includeModels = _.filter(config.includeModels, function(nm) {
        var uid = getUid(nm);

        if (uid === false) {
          return true; // keep the model till the next iteration
        }

        config.includeUids.push(uid);
        dirty = true;
      });

      config.excludeModels = _.filter(config.excludeModels, function(nm) {
        var uid = getUid(nm);

        if (uid === false) {
          return true; // keep the model till the next iteration
        }

        config.excludeUids.push(uid);
        dirty = true;
      });

      config.deleteModels = _.filter(config.deleteModels, function(nm) {
        var uid = getUid(nm);

        if (uid === false) {
          return true; // keep the model till the next iteration
        }

        config.deleteUids.push(uid);
        dirty = true;
      });

      _.each(config.includeUids, function(uid) {
        dirty = setMode(uid, 1) || dirty;
      });

      config.includeUids = [];

      _.each(config.excludeUids, function(uid) {
        dirty = setMode(uid, 0) || dirty;
      });

      config.excludeUids = [];

      _.each(config.deleteUids, function(uid) {
        dirty = setMode(uid, -1) || dirty;
      });

      config.deleteUids = [];

      // remove duplicates
      if (dirty) {
        config.models = _.uniq(config.models, function(m) {
          return m.uid;
        });
      }

      var myModels = [];

      _.each(config.models, function(configModel) {
        var onlineModel = _.findWhere(onlineModels, {uid: configModel.uid});

        if (!_.isUndefined(onlineModel)) {
          // if the model does not have a name in config.models we use her name by default
          if (!configModel.nm) {
            configModel.nm = onlineModel.nm;
            dirty = true;
          }

          onlineModel.mode = configModel.mode;

          if (onlineModel.mode == 1) {
            if (onlineModel.vs === 0) {
              myModels.push(onlineModel);
            } else if (onlineModel.vs === 90) {
              printDebugMsg(colors.green(onlineModel.nm) + ' has vs == 90');
              myModels.push(onlineModel);
            } else {
              printMsg(colors.green(onlineModel.nm) + ' is away or in a private');
            }
          }
        }
      });

      printDebugMsg(myModels.length  + ' model(s) to capture');

      if (dirty) {
        printDebugMsg('Save changes in config.yml');

        fs.writeFileSync('config.yml', yaml.safeDump(config), 'utf8');

        dirty = false;
      }

      return myModels;
    });
}

function createCaptureProcess(model) {
  var modelCurrentlyCapturing = _.findWhere(modelsCurrentlyCapturing, {uid: model.uid});

  if (!_.isUndefined(modelCurrentlyCapturing)) {
    printDebugMsg(colors.green(model.nm) + ' is already capturing');
    return; // resolve immediately
  }

  printMsg(colors.green(model.nm) + ' is now online, starting capturing process');

  return Promise
    .try(function() {
      var filename = model.nm + '_' + getCurrentDateTime() + '.ts';

      var spawnArguments = [
        '-hide_banner',
        '-v',
        'fatal',
        '-i',
        'http://video' + (model.u.camserv - 500) + '.myfreecams.com:1935/NxServer/ngrp:mfc_' + (100000000 + model.uid) + '.f4v_mobile/playlist.m3u8?nc=1423603882490',
        // 'http://video' + (model.u.camserv - 500) + '.myfreecams.com:1935/NxServer/mfc_' + (100000000 + model.uid) + '.f4v_aac/playlist.m3u8?nc=1423603882490',
        '-c',
        'copy',
        config.captureDirectory + '/' + filename
      ];

      var captureProcess = childProcess.spawn('ffmpeg', spawnArguments);

      captureProcess.stdout.on('data', function(data) {
        printMsg(data.toString);
      });

      captureProcess.stderr.on('data', function(data) {
        printMsg(data.toString);
      });

      captureProcess.on('close', function(code) {
        printMsg(colors.green(model.nm) + ' stopped streaming');

        var modelCurrentlyCapturing = _.findWhere(modelsCurrentlyCapturing, {pid: captureProcess.pid});

        if (!_.isUndefined(modelCurrentlyCapturing)) {

          var modelIndex = modelsCurrentlyCapturing.indexOf(modelCurrentlyCapturing);

          if (modelIndex !== -1) {
            modelsCurrentlyCapturing.splice(modelIndex, 1);
          }
        }

        fs.stat(config.captureDirectory + '/' + filename, function(err, stats) {
          if (err) {
            if (err.code == 'ENOENT') {
              // do nothing, file does not exists
            } else {
              printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString());
            }
          } else if (stats.size == 0 || stats.size < (config.minFileSizeMb * 1048576)) {
            fs.unlink(config.captureDirectory + '/' + filename, function(err) {
              // do nothing, shit happens
            });
          } else {
            //ADD DIR FOR MODEL
            var modelDir = config.completeDirectory + '/' + model.uid + ' - ' + model.nm;
            mkdirp(modelDir, function(err) {
              if (err) {
                printErrorMsg(err);
              }
            });
            mv(config.captureDirectory + '/' + filename, modelDir + '/' + filename, function(err) {
              if (err) {
                printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString());
              }
            });
          }
        });
      });

      if (!!captureProcess.pid) {
        modelsCurrentlyCapturing.push({
          nm: model.nm,
          uid: model.uid,
          filename: filename,
          captureProcess: captureProcess,
          pid: captureProcess.pid,
          checkAfter: getTimestamp() + 600, // we are gonna check the process after 10 min
          size: 0
        });
      }
    })
    .catch(function(err) {
      printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString());
    });
}

function checkCaptureProcess(model) {
  var onlineModel = _.findWhere(onlineModels, {uid: model.uid});

  if (!_.isUndefined(onlineModel)) {
    if (onlineModel.mode == 1) {
      onlineModel.capturing = true;
    } else if (!!model.captureProcess) {
      // if the model has been excluded or deleted we stop capturing process and resolve immediately
      printDebugMsg(colors.green(model.nm) + ' has to be stopped');
      model.captureProcess.kill();
      return;
    }
  }

  // if this is not the time to check the process then we resolve immediately
  if (model.checkAfter > getTimestamp()) {
    return;
  }

  return fs
    .statAsync(config.captureDirectory + '/' + model.filename)
    .then(function(stats) {
      // we check the process every 10 minutes since its start,
      // if the size of the file has not changed for the last 10 min, we kill the process
      if (stats.size - model.size > 0) {
        printDebugMsg(colors.green(model.nm) + ' is alive');

        model.checkAfter = getTimestamp() + 600; // 10 minutes
        model.size = stats.size;
      } else if (!!model.captureProcess) {
        // we assume that onClose will do all clean up for us
        printErrorMsg('[' + colors.green(model.nm) + '] Process is dead');
        model.captureProcess.kill();
      } else {
        // suppose here we should forcefully remove the model from modelsCurrentlyCapturing
        // because her captureProcess is unset, but let's leave this as is
      }
    })
    .catch(function(err) {
      if (err.code == 'ENOENT') {
        // do nothing, file does not exists,
        // this is kind of impossible case, however, probably there should be some code to "clean up" the process
      } else {
        printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString());
      }
    });
}

function mainLoop() {
  printDebugMsg('Start searching for new models');

  Promise
    .try(function() {
      return getFileno();
    })
    .then(function(fileno) {
      return getOnlineModels(fileno);
    })
    .then(function() {
      return selectMyModels();
    })
    .then(function(myModels) {
      return Promise.all(myModels.map(createCaptureProcess));
    })
    .then(function() {
      return Promise.all(modelsCurrentlyCapturing.map(checkCaptureProcess));
    })
    .then(function() {
      models = onlineModels;
    })
    .catch(function(err) {
      printErrorMsg(err);
    })
    .finally(function() {
      dumpModelsCurrentlyCapturing();

      printMsg('Done, will search for new models in ' + config.modelScanInterval + ' second(s).');

      setTimeout(mainLoop, config.modelScanInterval * 1000);
    });
}

var session = bhttp.session();

var models = new Array();
var onlineModels = new Array();
var modelsCurrentlyCapturing = new Array();

var config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));

config.port = config.port || 9080;
config.minFileSizeMb = config.minFileSizeMb || 0;

config.captureDirectory = path.resolve(config.captureDirectory);
config.completeDirectory = path.resolve(config.completeDirectory);

mkdirp(config.captureDirectory, function(err) {
  if (err) {
    printErrorMsg(err);
    process.exit(1);
  }
});

mkdirp(config.completeDirectory, function(err) {
  if (err) {
    printErrorMsg(err);
    process.exit(1);
  }
});

config.includeModels = Array.isArray(config.includeModels) ? config.includeModels : [];
config.excludeModels = Array.isArray(config.excludeModels) ? config.excludeModels : [];
config.deleteModels = Array.isArray(config.deleteModels) ? config.deleteModels : [];

config.includeUids = Array.isArray(config.includeUids) ? config.includeUids : [];
config.excludeUids = Array.isArray(config.excludeUids) ? config.excludeUids : [];
config.deleteUids = Array.isArray(config.deleteUids) ? config.deleteUids : [];

// convert the list of models to the new format
var dirty = false;

if (config.models.length > 0) {
  config.models = config.models.map(function(m) {

    if (typeof m === 'number') { // then this "simple" uid
      m = {uid: m, include: 1};

      dirty = true;
    } else if (_.isUndefined(m.mode)) { // if there is no mode field this old version
      m.mode = !m.excluded ? 1 : 0;
      dirty = true;
    }

    return m;
  });
}

if (dirty) { // then there were some changes in the list of models
  printDebugMsg('Save changes in config.yml');

  fs.writeFileSync('config.yml', yaml.safeDump(config), 0, 'utf8');

  dirty = false;
}

mainLoop();

dispatcher.onGet('/', function(req, res) {
  fs.readFile('./index.html', function(err, data) {
    if (err) {
      res.writeHead(404, {'Content-Type': 'text/html'});
      res.end('Not Found');
    } else {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(data, 'utf-8');
    }
  });
});

// return an array of online models
dispatcher.onGet('/models', function(req, res) {
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(models));
});

// when we include the model we only "express our intention" to do so,
// in fact the model will be included in the config only with the next iteration of mainLoop
dispatcher.onGet('/models/include', function(req, res) {
  if (req.params && req.params.uid) {
    var uid = parseInt(req.params.uid, 10);

    if (!isNaN(uid)) {
      printDebugMsg(colors.green(uid) + ' to include');

      // before we include the model we check that the model is not in our "to exclude" or "to delete" lists
      remove(req.params.nm, config.excludeUids);
      remove(req.params.nm, config.deleteUids);

      config.includeUids.push(uid);

      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({uid: uid})); // this will be sent back to the browser

      var model = _.findWhere(models, {uid: uid});

      if (!_.isUndefined(model)) {
        model.nextMode = 1;
      }

      return;
    }
  } else if (req.params && req.params.nm) {
    printDebugMsg(colors.green(req.params.nm) + ' to include');

    // before we include the model we check that the model is not in our "to exclude" or "to delete" lists
    remove(req.params.nm, config.excludeModels);
    remove(req.params.nm, config.deleteModels);

    config.includeModels.push(req.params.nm);

    dirty = true;

    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({nm: req.params.nm})); // this will be sent back to the browser

    var model = _.findWhere(models, {nm: req.params.nm});

    if (!_.isUndefined(model)) {
      model.nextMode = 1;
    }

    return;
  }

  res.writeHead(422, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({error: 'Invalid request'}));
});

// whenever we exclude the model we only "express our intention" to do so,
// in fact the model will be exclude from config only with the next iteration of mainLoop
dispatcher.onGet('/models/exclude', function(req, res) {
  if (req.params && req.params.uid) {
    var uid = parseInt(req.params.uid, 10);

    if (!isNaN(uid)) {
      printDebugMsg(colors.green(uid) + ' to exclude');

      // before we exclude the model we check that the model is not in our "to include" or "to delete" lists
      remove(req.params.nm, config.includeUids);
      remove(req.params.nm, config.deleteUids);

      config.excludeUids.push(uid);

      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({uid: uid})); // this will be sent back to the browser

      var model = _.findWhere(models, {uid: uid});

      if (!_.isUndefined(model)) {
        model.nextMode = 0;
      }

      return;
    }
  } else if (req.params && req.params.nm) {
    printDebugMsg(colors.green(req.params.nm) + ' to exclude');

    // before we exclude the model we check that the model is not in our "to include" or "to delete" lists
    remove(req.params.nm, config.includeModels);
    remove(req.params.nm, config.deleteModels);

    config.excludeModels.push(req.params.nm);

    dirty = true;

    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({nm: req.params.nm})); // this will be sent back to the browser

    var model = _.findWhere(models, {nm: req.params.nm});

    if (!_.isUndefined(model)) {
      model.nextMode = 0;
    }

    return;
  }

  res.writeHead(422, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({error: 'Invalid request'}));
});

// whenever we delete the model we only "express our intention" to do so,
// in fact the model will be markd as "deleted" in config only with the next iteration of mainLoop
dispatcher.onGet('/models/delete', function(req, res) {
  if (req.params && req.params.uid) {
    var uid = parseInt(req.params.uid, 10);

    if (!isNaN(uid)) {
      printDebugMsg(colors.green(uid) + ' to delete');

      // before we exclude the model we check that the model is not in our "to include" or "to exclude" lists
      remove(req.params.nm, config.includeUids);
      remove(req.params.nm, config.excludeUids);

      config.deleteUids.push(uid);

      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({uid: uid})); // this will be sent back to the browser

      var model = _.findWhere(models, {uid: uid});

      if (!_.isUndefined(model)) {
        model.nextMode = -1;
      }

      return;
    }
  } else if (req.params && req.params.nm) {
    printDebugMsg(colors.green(req.params.nm) + ' to delete');

    // before we exclude the model we check that the model is not in our "to include" or "to exclude" lists
    remove(req.params.nm, config.includeModels);
    remove(req.params.nm, config.excludeModels);

    config.deleteModels.push(req.params.nm);

    dirty = true;

    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({nm: req.params.nm})); // this will be sent back to the browser

    var model = _.findWhere(models, {nm: req.params.nm});

    if (!_.isUndefined(model)) {
      model.nextMode = -1;
    }

    return;
  }

  res.writeHead(422, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({error: 'Invalid request'}));
});

dispatcher.onError(function(req, res) {
  res.writeHead(404);
});

http.createServer(function(req, res) {
  dispatcher.dispatch(req, res);
}).listen(config.port, function() {
  printMsg('Server listening on: ' + colors.green('0.0.0.0:' + config.port));
});
