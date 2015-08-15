var Utils = require("../utils");
var wordnet = require("../wordnet");
var replace = require("async-replace");
var _ = require("lodash");
var debug = require("debug")("RegexReply");
var dWarn = require("debug")("RegexReply:Warning");

// Prepares a trigger for the regular expression engine.

var processAlternates = function (reply) {
  // input Alternates.

  var primary = reply.match(/(.?\(.+?\))/g);

  if (primary) {
    for (var n = 0; n < primary.length; n++) {
      // Filter out new Min, Max Wildcard Syntax
      if (primary[n][0] !== "*") {

        var match = reply.match(/\((.+?)\)/g);

        if (match) {
          for (var i = 0; i < match.length; i++) {
            var altGroup = match[i];
            var altMatch = altGroup.match(/\((.+?)\)/);

            var altStr = altMatch[1];
            var parts = altStr.split("|");

            var opts = [];
            for (var nn = 0; nn < parts.length; nn++) {
              opts.push(parts[nn].trim());
            }

            opts = "(\\b" + opts.join("\\b|\\b") + "\\b)\\s?";
            reply = reply.replace(altGroup, opts);
          }
        }
      }
    }
  }

  return reply;
};

exports.parse = function (regexp, facts, callback) {
  regexp = processAlternates(regexp);

  // If the trigger is simply '*' then the * needs to become (.*?)
  // to match the blank string too.
  regexp = regexp.replace(/^\*$/, "<zerowidthstar>");

  // Simple replacements.
  // This replacement must be done before the next or they will conflict.
  // * replacement is now optional by default meaning 0,n
  // Match Single * allowing *~n and *n to pass though
  // regexp = regexp.replace(/\s?\*(?!~?\d)\s?/g, "(?:.*\\s?)");  // Convert * into (.*)
  // Added new (min-max) - http://rubular.com/r/lW6FoLRxph
  regexp = regexp.replace(/\s?\*(?![~?\d\(])\s?/g, "(?:.*\\s?)");  // Convert * into (.*)

  // Step 1 nWidthStar
  // (\s?(?:[\w]*\s?){n})
  // Here we match *n where n is the number of words to allow
  // This provides much more flexibility around matching adverbs with nouns.
  // We deliberately slurp in the trailing space to support zero or more words
  var nWidthStarMatch = function (match, p1) {
    if (p1) {
      debug("E WIDTH STAR", p1, match);
    }
    return "<" + parseInt(p1) + "ewidthstar>";
  };

  // Step 2 nWidthStar
  // (\s?(?:[\w]*\s?){0,n})
  var varWidthStarReplace = function (match, p1) {
    if (p1) {
      debug("V WIDTH STAR", p1, match);
    }

    var num = parseInt(p1.replace("~", ""));
    return "<" + num + "vwidthstar>";
  };

  // Step 3 mix-maxWidthStar
  var mmWidthStarReplace = function (match, p1) {
    if (p1) {
      debug("MM WIDTH STAR", p1, match);
    }
    var parts = p1.split("-");
    if (parts.length === 2) {
      var v1 = parseInt(parts[0]);
      var v2 = parseInt(parts[1]);
      if (v1 === v2) {
        dWarn("MM Values are the same, dropping back to Exact Match");
        return "<" + v2 + "vwidthstar>";
      } else {
        return "<" + v1 + "," + v2 + "mmwidthstar>";
      }
    }
  };

  // Convert *n into multi word EXACT match
  regexp = regexp.replace(/\*([0-9]{1,2})/g, nWidthStarMatch);

  // Convert *(n) into multi word EXACT match
  regexp = regexp.replace(/\*\(([0-9]{1,2}\s?)\)/g, nWidthStarMatch);

  // Convert *~n into multi word VARIABLE match
  regexp = regexp.replace(/\s?\*(~[0-9]{1,2}\s?)/g, varWidthStarReplace);

  // Convert *(n-m) into multi word VARIABLE match
  regexp = regexp.replace(/\*\((\d{1,2}\-\d{1,2}\s?)\)/g, mmWidthStarReplace);
  regexp = regexp.replace(/<zerowidthstar>/g, "(?:.*?)");

  // Handle WordNet
  var wordnetReplace = function (match, sym, word, p3, offset, done) {
    // Use FactSystem first.

    facts.conceptToList(word.toLowerCase(), function (err, words) {
      if (err) {
        console.log(err);
      }

      if (!_.isEmpty(words)) {
        words = "(\\b" + words.join("\\b|\\b") + "\\b)";
        debug("Fact Replies", words);
        done(null, words);

      } else {
        wordnet.lookup(word, sym, function (err2, words) {
          if (err2) {
            console.log(err2);
          }

          // TODO add a space around the terms
          words = words.map(function (item) {
            return item.replace(/_/g, " ");
          });

          if (_.isEmpty(words)) {
            dWarn("Creating a trigger with a word NOT EXPANDED", match);
            done(null, match);
          } else {

            words = "(\\b" + words.join("\\b|\\b") + "\\b)";
            debug("Wordnet Replies", words);
            done(null, words);
          }
        });
      }
    });
  };

  replace(regexp, /(~)(\w[\w]+)/g, wordnetReplace, function (err, result) {
    if (err) {
      console.log(err);
    }

    regexp = result;

    // Optionals.
    var match = regexp.match(/\[(.+?)\]/);
    var giveup = 0;
    while (match) {
      giveup++;
      if (giveup >= 50) {
        dWarn("Infinite loop when trying to process optionals in trigger!");
        return "";
      }

      var parts = match[1].split("|");
      var opts = [];
      for (var i = 0; i < parts.length; i++) {
        var p = "\\s*" + parts[i] + "\\s*";
        opts.push(p);
      }

      opts.push("\\s*");

      // If this optional had a star or anything in it, make it non-matching.
      var pipes = opts.join("|");
      pipes = pipes.replace(new RegExp(Utils.quotemeta("(.+?)"), "g"), "(?:.+?)");
      pipes = pipes.replace(new RegExp(Utils.quotemeta("(\\d+?)"), "g"), "(?:\\d+?)");
      pipes = pipes.replace(new RegExp(Utils.quotemeta("([A-Za-z]+?)"), "g"), "(?:[A-Za-z]+?)");

      regexp = regexp.replace(new RegExp("\\s*\\[" + Utils.quotemeta(match[1]) + "\\]\\s*"),
        "(?:" + pipes + ")");
      match = regexp.match(/\[(.+?)\]/); // Circle of life!
    }

    // neWidthStar
    var exactWidthReplace = function(match2, p1) {
      return "(\\S+(:?\\s+\\S+){" + (parseInt(p1) - 1) + "})";
    };

    regexp = regexp.replace(/<(\d+)ewidthstar>/g, exactWidthReplace);

    // nvWidthStar
    var varWidthReplace = function (match3, p1) {
      return "(\\s?(?:[\\w-]*\\s?){0," + parseInt(p1) + "})";
    };

    regexp = regexp.replace(/<(\d+)vwidthstar>/g, varWidthReplace);

    // mmvWidthStar
    var mmWidthReplace = function (match4, p1) {
      var parts = p1.split(",");
      return "(\\s?(?:[\\w-]*\\s?){" + parseInt(parts[0]) + "," + parseInt(parts[1]) + "})";
    };

    regexp = regexp.replace(/<(\d+,\d+)mmwidthstar>/g, mmWidthReplace);
    callback(regexp);
  });
};

// This function can be done after the first and contains the
// user object so it may be contextual to this user.
exports.postParse = function (regexp, message, user, callback) {
  if (_.isNull(regexp)) {
    callback(null);
  } else {
    if (regexp.indexOf("<name") > -1 && message.names.length !== 0) {
      // TODO - Scan ahead to detect the highest
      for (i = 0; i < message.names.length; i++) {
        var varNamesRE = new RegExp("<name" + (i + 1) + ">", "g");
        regexp = regexp.replace(varNamesRE, "(" + message.names[i] + ")");
      }
      var nameRE = new RegExp("<name>", "g");
      var namesRE = new RegExp("<names>", "g");
      regexp = regexp.replace(nameRE, "(" + message.names[0] + ")");
      regexp = regexp.replace(namesRE, "(" + message.names.join("|") + ")");
    }

    if (regexp.indexOf("<noun") > -1 && message.nouns.length !== 0) {
      for (i = 0; i < message.nouns.length; i++) {
        var varNounsRE = new RegExp("<noun" + (i + 1) + ">", "g");
        regexp = regexp.replace(varNounsRE, "(" + message.nouns[i] + ")");
      }
      var nounRE = new RegExp("<noun>", "g");
      var nounsRE = new RegExp("<nouns>", "g");
      regexp = regexp.replace(nounRE, "(" + message.nouns[0] + ")");
      regexp = regexp.replace(nounsRE, "(" + message.nouns.join("|") + ")");
    }

    if (regexp.indexOf("<adverb") > -1 && message.adverbs.length !== 0) {
      for (i = 0; i < message.adverbs.length; i++) {
        var varAdverbRE = new RegExp("<adverb" + (i + 1) + ">", "g");
        regexp = regexp.replace(varAdverbRE, "(" + message.adverbs[i] + ")");
      }
      var adverbRE = new RegExp("<adverb>", "g");
      var adverbsRE = new RegExp("<adverbs>", "g");
      regexp = regexp.replace(adverbRE, "(" + message.adverbs[0] + ")");
      regexp = regexp.replace(adverbsRE, "(" + message.adverbs.join("|") + ")");
    }

    if (regexp.indexOf("<verb") > -1 && message.verbs.length !== 0) {
      for (var i = 0; i < message.verbs.length; i++) {
        var varVerbRE = new RegExp("<verb" + (i + 1) + ">", "g");
        regexp = regexp.replace(varVerbRE, "(" + message.verbs[i] + ")");
      }
      regexp = regexp.replace(new RegExp("<verb>", "g"), "(" + message.verbs[0] + ")");
      regexp = regexp.replace(new RegExp("<verbs>", "g"), "(" + message.verbs.join("|") + ")");
    }

    if (regexp.indexOf("<pronoun") > -1 && message.pronouns.length !== 0) {
      for (i = 0; i < message.pronouns.length; i++) {
        var varProRE = new RegExp("<pronoun" + (i + 1) + ">", "g");
        regexp = regexp.replace(varProRE, "(" + message.pronouns[i] + ")");
      }
      var proRE = new RegExp("<pronoun>", "g");
      var prosRE = new RegExp("<pronouns>", "g");
      regexp = regexp.replace(proRE, "(" + message.pronouns[0] + ")");
      regexp = regexp.replace(prosRE, "(" + message.pronouns.join("|") + ")");
    }

    if (regexp.indexOf("<adjective") > -1 && message.adjectives.length !== 0) {
      for (i = 0; i < message.adjectives.length; i++) {
        var varAdjRE = new RegExp("<adjective" + (i + 1) + ">", "g");
        regexp = regexp.replace(varAdjRE, "(" + message.adjectives[i] + ")");
      }

      var adjRE = new RegExp("<adjective>", "g");
      var adjsRE = new RegExp("<adjectives>", "g");
      regexp = regexp.replace(adjRE, "(" + message.adjectives[0] + ")");
      regexp = regexp.replace(adjsRE, "(" + message.adjectives.join("|") + ")");
    }

    if (regexp.indexOf("<input") > -1 || regexp.indexOf("<reply") > -1) {
      // Filter in <input> and <reply> tags.
      debug("Input, Reply Match Found");
      var types = ["input", "reply"];
      for (i = 0; i < 2; i++) {
        var type = types[i];
        // Numbered Replies/Inputs 1 - 9
        for (var j = 1; j <= 9; j++) {
          if (regexp.indexOf("<" + type + j + ">") && user.__history__[type][j]) {
            var historyRE = new RegExp("<" + type + j + ">", "g");
            regexp = regexp.replace(historyRE, user.__history__[type][j].raw);
          }
        }

        // Generic Reply/Input (first one)
        if (user.__history__[type][0]) {
          var hisRE = new RegExp("<" + type + ">", "g");
          regexp = regexp.replace(hisRE, user.__history__[type][0].raw);
        }
      }
    }
  }

  callback(regexp);
};
