var async = require("async");
var replace = require("async-replace");
var Utils = require("./utils");
var wordnet = require("./wordnet");
var _ = require("lodash");
var Message = require("./message");
var debug = require("debug")("ProcessTags");
var dWarn = require("debug")("ProcessTags:Warning");

var topicSetter = function (reply) {

  // TODO - Topic Setter should have its own property
  var match = reply.match(/\{topic=(.+?)\}/i);
  var giveup = 0;
  var newtopic;

  while (match) {
    giveup++;
    if (giveup >= 50) {
      dWarn("Infinite loop looking for topic tag!");
      break;
    }
    var name = match[1];
    newtopic = name;
    reply = reply.replace(new RegExp("{topic=" + Utils.quotemeta(name) + "}", "ig"), "");
    match = reply.match(/\{topic=(.+?)\}/i); // Look for more
  }
  return [reply, newtopic];
};

var parseCustomFunctions = function (reply, plugins, scope, callback) {
  // New Custom Function Handle
  // This matches the Redirect finder above
  var match = reply.match(/\^(\w+)\(([\w<>,\s\.\-]*)\)/);

  // We use async to capture multiple matches in the same reply
  return async.whilst(
    function () {
      return match;
    },
    function (cb) {
      // Call Function here

      var main = match[0];
      var pluginName = Utils.trim(match[1]);
      var partsStr = Utils.trim(match[2]);
      var parts = partsStr.split(",");

      var args = [];
      for (var i = 0; i < parts.length; i++) {
        if (parts[i] !== "") {
          args.push(parts[i].trim());
        }
      }

      if (plugins[pluginName]) {

        // SubReply is the results of the object coming back
        // TODO. Subreply should be optional and could be undefined, or null
        args.push(function customFunctionHandle(err, subreply) {

          match = false;
          reply = reply.replace(main, subreply);
          match = reply.match(/\^(\w+)\(([~\w<>,\s\.\-]*)\)/);
          if (err) {
            cb(err);
          } else {
            cb();
          }
        });

        debug("Calling Plugin Function", pluginName);
        plugins[pluginName].apply(scope, args);

      } else {
        // If a function is missing, we kill the line and return empty handed
        dWarn("Custom Function not-found", pluginName);
        match = false;
        cb(null, "");
      }
    },
    function (err) {
      if (err) {
        callback(null, "");
      } else {
        callback(null, Utils.trim(reply));
      }
    }
  );
};

var processAlternates = function (reply) {
  // Reply Alternates.
  var match = reply.match(/\(\((.+?)\)\)/);
  var giveup = 0;
  while (match) {
    debug("Reply has Alternates");

    giveup++;
    if (giveup >= 50) {
      dWarn("Infinite loop when trying to process optionals in trigger!");
      return "";
    }

    var parts = match[1].split("|");
    var opts = [];
    for (var i = 0; i < parts.length; i++) {
      opts.push(parts[i].trim());
    }

    var resp = Utils.getRandomInt(0, opts.length - 1);
    reply = reply.replace(new RegExp("\\(\\(\\s*" + Utils.quotemeta(match[1]) + "\\s*\\)\\)"), opts[resp]);
    match = reply.match(/\(\((.+?)\)\)/);
  }

  return reply;
};


// Handle WordNet in Replies
var wordnetReplace = function (match, sym, word, p3, offset, done) {
  wordnet.lookup(word, sym, function (err, words) {
    if (err) {
      console.log(err);
    }

    words = words.map(function (item) {
      return item.replace(/_/g, " ");
    });
    debug("Wordnet Replies", words);
    var resp = Utils.pickItem(words);
    done(null, resp);
  });
};

// Process tags in a reply element.
exports.replies = function (replyObj, user, options, callback) {

  var reply = replyObj.reply.reply;
  var plugins = options.plugins;
  var globalScope = options.scope;
  var gDepth = options.depth;
  var gNormalize = options.normalize;
  var gFacts = options.facts;
  var gQtypes = options.qtypes;

  var match = false;
  var redirectMatch = false;
  var newtopic;

  // Kinda hacky to pluck the msg from scope.
  var msg = globalScope.message;
  var duplicateMessage = false;


  var getTopic = function (name, cb) {
    options.system.topicsSystem.topic.findOne({name: name}, function(err, topicData) {
      if (!topicData) {
        cb(new Error("No Topic Found"));
      } else {
        debug("Getting Topic Data for", topicData);
        cb(err, {id: topicData._id, name: name, type: "TOPIC"});
      }
    });
  };

  // Lets set the currentTopic to whatever we matched on.
  // The reply text might override that later.
  user.setTopic(replyObj.topic);

  var rt = topicSetter(reply);
  reply = rt[0];
  if (rt[1] !== "") {
    newtopic = rt[1];
  }

  // Check for reply keep flag, this will override the topicFlag
  // TODO - Strip this off in getReply.
  match = reply.match(/\{keep\}/i);
  if (match) {
    reply = reply.replace(new RegExp("{keep}", "ig"), "");
  }

  var stars = [""];
  stars.push.apply(stars, replyObj.stars);

  // Replace <cap> and <capN>
  reply = reply.replace(/<cap>/ig, stars[1]);
  for (var i = 1; i <= stars.length; i++) {
    reply = reply.replace(new RegExp("<cap" + i + ">", "ig"), stars[i]);
  }

  // Inline redirector.
  // This is a real bitch because we no longer return
  redirectMatch = reply.match(/\{@(.+?)\}/);

  if (redirectMatch) {
    options = {
      user: user,
      depth: gDepth + 1,
      system: {
        plugins: plugins,
        scope: globalScope,
        topicsSystem: options.topicSystem,

        // Message
        question: gQtypes,
        normalize: gNormalize,
        facts: gFacts
      }
    };


    return async.whilst(
      function () {
        return redirectMatch;
      },
      function (cb) {
        debug("ReplyObj", replyObj);
        var getreply = require("./getreply");
        var target = redirectMatch[1];
        debug("Inline redirection to: '" + target + "'");

        var messageOptions = {
          qtypes: gQtypes,
          norm: gNormalize,
          facts: gFacts
        };

        getTopic(replyObj.topic, function (err, topicData) {
          options.aTopics = [];
          options.aTopics.push(topicData);

          new Message(target, messageOptions, function (replyMessageObject) {
            options.message = replyMessageObject;
            getreply(options, function (err, subreply) {
              if (err) {
                console.log(err);
              }

              if (subreply) {
                var rd1 = new RegExp("\\{@" + Utils.quotemeta(target) + "\\}", "i");
                reply = reply.replace(rd1, subreply.string);
                redirectMatch = reply.match(/\{@(.+?)\}/);
              } else {
                redirectMatch = false;
                reply = reply.replace(new RegExp("\\{@" + Utils.quotemeta(target) + "\\}", "i"), "");
              }

              if (gDepth === 50) {
                cb("Depth Error");
              } else {
                cb(null);
              }
            }); // getReply
          }); // Message
        });
      },
      function (err) {
        if (err) {
          return callback(err, "", globalScope.message.props);
        } else {
          debug("CallBack from inline redirect", Utils.trim(reply));

          parseCustomFunctions(reply, plugins, globalScope, function (err2, newReply) {
            if (err2) {
              console.log(err2);
            }

            return callback(null, Utils.trim(newReply), globalScope.message.props);
          });
        }
      }
    );
  }

  reply = Utils.trim(reply);
  reply = reply.replace(/\\s/ig, " ");
  reply = reply.replace(/\\n/ig, "\n");
  reply = reply.replace(/\\#/ig, "#");

  // <input> and <reply>

  // Special case, we have no items in the history yet,
  // This could only happen if we are trying to match the first input.
  // Kinda edgy.

  if (!_.isNull(msg)) {
    reply = reply.replace(/<input>/ig, msg.clean);
  }

  reply = reply.replace(/<reply>/ig, user.__history__.reply[0]);
  for (i = 1; i <= 9; i++) {
    if (reply.indexOf("<input" + i + ">")) {
      reply = reply.replace(new RegExp("<input" + i + ">", "ig"),
        user.__history__.input[i - 1]);
    }
    if (reply.indexOf("<reply" + i + ">")) {
      reply = reply.replace(new RegExp("<reply" + i + ">", "ig"),
        user.__history__.reply[i - 1]);
    }
  }


  redirectMatch = reply.match(/\^topicRedirect\(\s*([~\w<>\s]*),([~\w<>\s]*)\s*\)/);

  if (redirectMatch) {

    options = {
      user: user,
      depth: gDepth + 1,
      system: {
        plugins: plugins,
        scope: globalScope,
        topicsSystem: options.topicSystem,

        // Message
        question: gQtypes,
        normalize: gNormalize,
        facts: gFacts
      }
    };

    return async.whilst(
      function () {
        return redirectMatch;
      },
      function (cb) {
        var main = Utils.trim(redirectMatch[0]);
        var topic = Utils.trim(redirectMatch[1]);
        var target = Utils.trim(redirectMatch[2]);
        var getreply = require("./getreply");
        debug("Topic Redirection to: " + target + " topic:" + topic);
        user.setTopic(topic);

        var messageOptions = {
          qtypes: gQtypes,
          norm: gNormalize,
          facts: gFacts
        };

        getTopic(topic, function (err, topicData) {
          if (err) {
            /*
              In this case the topic does not exist, we want to just pretend it wasn't
              provided and reply with whatever else is there.
             */
            redirectMatch = reply.match(/\^topicRedirect\(\s*([~\w<>\s]*),([~\w<>\s]*)\s*\)/);
            reply = Utils.trim(reply.replace(main, ""));
            debug("Invalid Topic", reply);
            return cb(null);
          }

          options.aTopics = [];
          options.aTopics.push(topicData);

          new Message(target, messageOptions, function (replyMessageObject) {

            options.message = replyMessageObject;
            // Pass the stars forward
            options.message.stars = stars.slice(1);
            getreply(options, function (err, subreply) {
              if (err) {
                cb(null);
              }

              if (subreply) {
                debug("CallBack from inline redirect", subreply.string);
                reply = reply.replace(main, subreply.string);
                redirectMatch = reply.match(/\^topicRedirect\(\s*([~\w<>\s]*),([~\w<>\s]*)\s*\)/);
              } else {
                redirectMatch = false;
                reply = reply.replace(main, "");
              }

              if (gDepth === 50) {
                cb("Depth Error");
              } else {
                cb(null);
              }
            }); // getReply
          }); // Message
        });

      },
      function (err) {
        if (err) {
          return callback(err, "");
        } else {
          // debug("CallBack from inline redirect", Utils.trim(reply));
          // return callback(null, Utils.trim(reply));

          debug("CallBack from inline redirect", reply);
          return callback(null, reply, globalScope.message.props);
        }
      }
    );
  }

  // System function for checking matches in a specific topic
  // This is like redirect accept we search matches in a new topic so it is more fuzzy
  // This would be used to access topics in a unlisted system function
  var respondMatch = reply.match(/\^respond\(\s*([\w~]*)\s*\)/);

  if (respondMatch) {

    options = {
      user: user,
      depth: gDepth + 1,
      system: {
        plugins: plugins,
        scope: globalScope,
        topicsSystem: options.topicSystem,
        // Message
        question: gQtypes,
        normalize: gNormalize,
        facts: gFacts
      }
    };

    return async.whilst(
      function () {
        return respondMatch;
      },
      function (cb) {
        var getreply = require("./getreply");
        var newTopic = Utils.trim(respondMatch[1]);
        debug("Topic Check with new Topic: " + newTopic);

        getTopic(replyObj.topic, function (err, topicData) {

          options.aTopics = [];
          options.message = msg;
          options.aTopics.push(topicData);

          getreply(options, function (err, subreply) {
            if (err) {
              console.log(err);
            }

            debug("CallBack from respond topic", subreply);

            if (subreply) {
              reply = subreply.string || "";
              replyObj = subreply;
              respondMatch = reply.match(/\^respond\(\s*([\w~]*)\s*\)/);
            } else {
              respondMatch = false;
              reply = "";
              replyObj = {};
            }

            if (gDepth === 50) {
              cb("Depth Error");
            } else {
              cb(null);
            }
          });
        });
      },
      function (err) {
        if (err) {
          return callback(err, "", globalScope.message.props, replyObj);
        } else {
          debug("CallBack from Respond Function", reply);
          return callback(null, reply, globalScope.message.props, replyObj);
        }
      }
    );
  }

  // Async Replace because normal replace callback is SYNC.
  replace(reply, /(~)(\w[\w]+)/g, wordnetReplace, function (err, newReply) {
    if (err) {
      console.log(err);
    }

    if (newReply.match(/\^(\w+)\(([\w<>,\s\.\-]*)\)/)) {

      parseCustomFunctions(newReply, plugins, globalScope, function (err2, newReply2) {
        if (err2) {
          console.log(err2);
        }

        reply = processAlternates(newReply2);

        // Check that we dont have another topic change
        var rt2 = topicSetter(reply);
        reply = rt2[0];
        if (rt2[1] !== "") {
          newtopic = rt2[1];
        }

        // We only want to change topics if the message has not been exausted
        if (newtopic && !duplicateMessage) {
          debug("Topic Change", newtopic);
          user.setTopic(newtopic);
        }

        debug("Calling back with", reply);
        callback(err, reply, globalScope.message.props);

      });

    } else {
      reply = processAlternates(newReply);

      // We only want to change topics if the message has not been exausted
      if (newtopic && !duplicateMessage) {
        debug("Topic Change", newtopic);
        user.setTopic(newtopic);
      }

      debug("Calling back with", reply);
      callback(null, reply, globalScope.message.props);
    }
  });
};


exports.threads = function(string) {
  var threads = [];
  var lines = string.split("\n");
  var strArr = [];
  for (var i = 0; i < lines.length; i++) {
    // http://rubular.com/r/CspCPIALNl
    var delayMatch = lines[i].match(/{\s*delay\s*=\s*(\d+)\s*}/);
    if (delayMatch) {
      var reply = Utils.trim(lines[i].replace(delayMatch[0], ""));
      threads.push({delay:delayMatch[1], string: reply});
    } else {
      strArr.push(lines[i]);
    }
  }
  return [strArr.join("\n"), threads];
};
