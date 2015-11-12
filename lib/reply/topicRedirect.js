var processHelpers = require("./common");
var Message = require("../message");
var Utils = require("../utils");
var async = require("async");
var debug = require("debug")("Reply:topicRedirect");

var TOPIC_REGEX = /\^topicRedirect\(\s*([~\w<>\s]*),([~\w<>\s]*)\s*\)/;

module.exports = function(reply, stars, redirectMatch, options, callback) {

  var messageOptions = {
    qtypes: options.system.question,
    norm: options.system.normalize,
    facts: options.system.facts
  };

  var replyObj = {};

  return async.whilst(
    function () {
      return redirectMatch;
    },
    function (cb) {
      var main = Utils.trim(redirectMatch[0]);
      var topic = Utils.trim(redirectMatch[1]);
      var target = Utils.trim(redirectMatch[2]);
      var getreply = require("../getreply");

      debug("Topic Redirection to: " + target + " topic: " + topic);
      options.user.setTopic(topic);

      // Here we are looking for gambits in the NEW topic.
      processHelpers.getTopic(options.system.topicsSystem, topic, function (err, topicData) {
        if (err) {
          /*
            In this case the topic does not exist, we want to just pretend it wasn't
            provided and reply with whatever else is there.
           */
          redirectMatch = reply.match(TOPIC_REGEX);
          reply = Utils.trim(reply.replace(main, ""));
          debug("Invalid Topic", reply);
          return cb(null);
        }

        options.aTopics = [];
        options.aTopics.push(topicData);

        new Message(target, messageOptions, function (replyMessageObject) {
          options.message = replyMessageObject;

          // Pass the stars (captured wildcards) forward
          options.message.stars = stars.slice(1);

          getreply(options, function (err, subreply) {
            if (err) {
              cb(null);
            }

            if (subreply) {

              // We need to do a lookup on subreply.replyId and flash the entire reply.
              debug("CallBack from inline redirect", subreply);
              options.system.topicsSystem.reply.findById(subreply.replyId)
                .exec(function (err, fullReply) {
                if (err) {
                  console.log(err);
                }

                reply = reply.replace(main, fullReply.reply);
                replyObj = subreply;
                // Override the subreply string with the new complex one
                replyObj.string = reply;
                replyObj.reply = fullReply;
                replyObj.reply.reply = reply;
                redirectMatch = reply.match(TOPIC_REGEX);
                cb((options.depth === 50) ? "Depth Error" : null);
              });
            } else {
              redirectMatch = false;
              reply = reply.replace(main, "");
              replyObj = {};
              cb((options.depth === 50) ? "Depth Error" : null);
            }

          }); // getReply
        }); // Message

      });
    },
    function (err) {
      debug("CallBack from topic redirect", reply, replyObj);
      return callback(err, Utils.trim(reply), options.system.scope.message.props, replyObj);
    }
  );
};
