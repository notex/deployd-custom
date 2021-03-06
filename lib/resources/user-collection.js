var validation = require('validation')
  , util = require('util')
  , Collection = require('./collection')
  , db = require('../db')
  , EventEmitter = require('events').EventEmitter
  , uuid = require('../util/uuid')
  , crypto = require('crypto')
  , _ = require('underscore')
  , debug = require('debug')('user-collection');

/**
 * A `UserCollection` adds user authentication to the Collection resource.
 *
 * Settings:
 *
 *   - `path`                the base path a resource should handle
 *   - `config.properties`   the properties of objects the collection should store
 *   - `db`                  the database a collection will use for persistence
 *
 * @param {Object} options
 */

function UserCollection(name, options) {
  Collection.apply(this, arguments);

  var config = this.config;

  if(!this.properties) {
    this.properties = {};
  }

  // username and password are required
  this.properties.username = this.properties.username || {type: 'string'};
  this.properties.username.required = true;
  this.properties.password = this.properties.password || {type: 'string'};
  this.properties.password.required = true;
}
util.inherits(UserCollection, Collection);

UserCollection.dashboard = Collection.dashboard;
UserCollection.events    = _.clone(Collection.events);
UserCollection.events.push('Login');

UserCollection.SALT_LEN = 256;

/**
 * Handle an incoming http `req` and `res` and execute
 * the correct `Store` proxy function based on `req.method`.
 *
 *
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 */

UserCollection.prototype.handle = function (ctx) {
  var uc = this;

  if (ctx.req.method == "GET" && (ctx.url === '/count' || ctx.url.indexOf('/index-of') === 0)) {
    return Collection.prototype.handle.apply(uc, arguments);
  }

  if(ctx.url === '/logout') {
    if (ctx.res.cookies) ctx.res.cookies.set('sid', null, {overwrite: true});
    ctx.session.remove(ctx.done);
    return;
  }

  // set id if one wasnt provided in the query
  ctx.query.id = ctx.query.id || this.parseId(ctx) || (ctx.body && ctx.body.id);

  // make sure password will never be included
  if(ctx.query.$fields) {
    var omit = true;
    for (var field in ctx.query.$fields) {
      if (ctx.query.$fields.hasOwnProperty(field) && ctx.query.$fields[field] > 0) {
        omit = false;
        if ('password' in ctx.query.$fields) delete ctx.query.$fields.password;
      }
      break;
    }
    if (omit || Object.keys(ctx.query.$fields).length === 0) ctx.query.$fields.password = 0;
  } else ctx.query.$fields = {password: 0};

  switch(ctx.req.method) {
    case 'GET':
      if(ctx.url === '/me') {
        debug('session %j', ctx.session.data);
        noSuchUser = function () {
          // set no-cache headers
          ctx.res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          ctx.res.setHeader("Pragma", "no-cache");
          ctx.res.setHeader("Expires", "0");
          ctx.res.statusCode = 204;
          return ctx.done();
        };

        if(!(ctx.session && ctx.session.data && ctx.session.data.uid)) {
          return noSuchUser();
        }

        ctx.query = {id: ctx.session.data.uid};

        return this.find(ctx, function(err, user) {
          var userHash = uc.getUserAndPasswordHash(user);
          delete user.password;
          // verify that the username and password haven't changed since this session was created
          if (ctx.session.data.userhash === userHash) {
            ctx.done.apply(null, arguments);
          } else {
            noSuchUser();
          }
        });
      }

      this.find(ctx, ctx.done);
    break;
    case 'POST':
      if(ctx.url === '/login') {
        this.handleLogin(ctx);
        break;
      }
      /* falls through */
    case 'PUT':
      if(ctx.body && ctx.body.password) {
        this.setPassword(ctx.body);
      }
      var isSelf = ctx.session.user && ctx.session.user.id === ctx.query.id || (ctx.body && ctx.body.id);
      if ((ctx.query.id || ctx.body.id) && ctx.body && !isSelf && !ctx.session.isRoot && !ctx.req.internal) {
        delete ctx.body.username;
        delete ctx.body.password;
      }

      function done(err, res) {
        if (res) delete res.password;
        ctx.done(err, res);
      }

      if(ctx.query.id || ctx.body.id) {
        this.save(ctx, done);
      } else {
        this.store.first({username: ctx.body.username}, function (err, u) {
          if(u) return ctx.done({errors: {username: 'is already in use'}});
          uc.save(ctx, done);
        });
      }
    break;
    case 'DELETE':
      debug('removing', ctx.query, ctx.done);
      this.remove(ctx, ctx.done);
    break;
  }
};

UserCollection.prototype.loginFindUser = function (ctx, fn) {
  var credentials = ctx.req.body || { };
  return this.store.first({ username: credentials.username }, fn);
};

UserCollection.prototype.handleLogin = function (ctx) {
  var uc = this
    , path = uc.path
    , credentials = ctx.req.body || {};
  
  debug('trying to login as %s', credentials.username);
  /* jshint eqnull:true */
  // disable the jshint warning about needing === below
  // this checks whether the values are either null or undefined
  if (credentials.username == null || credentials.password == null) {
    ctx.res.statusCode = 400;
    ctx.done('username or password not specified');
    return;
  }
  
  this.loginFindUser(ctx, function (err, user) {
    if (err) return ctx.done(err);
    // keep a clone of the user so we can compare it later to see if any changes were made in the login event
    var userClone = user ? _.clone(user) : null
      , domain = { 'me': userClone, 'data': userClone, 'success': false };
    var usernameAndPasswordHash = user ? uc.getUserAndPasswordHash(user) : null;
    
    // checks if the user was changed in the login event and saves it if it was
    function checkAndSaveUser(fn) {
      if (user && !_.isEqual(userClone, user)) {
        // something was changed, need to update the user
        debug('detected that user %s was updated from login event, saving...', credentials.username);
        // create a new context and set the body to our user so that we can call save on the collection
        var newCtx = _.clone(ctx);
        newCtx.body = userClone;
        // skip events when calling uc.save, so that validate and put is not called from this
        // internal call
        newCtx._internalSkipEvents = true;
        newCtx.query = { id: user.id };
        // disable changing the username from this event
        if (newCtx.body.username) delete newCtx.body.username;
        if (newCtx.body.id) delete newCtx.body.id; // remove id from body
        
        uc.save(newCtx, fn);
      } else {
        fn();
      }
    }
    
    function loginDone(err) {
      if (err) return ctx.done(err);
      checkAndSaveUser(function (err) {
        if (err) return ctx.done(err);
        debug('logged in as %s', credentials.username);
        ctx.session.set({ path: path, uid: user.id, userhash: usernameAndPasswordHash }).save(function (err, session) {
          if (err) return ctx.done("Internal error");
          ctx.res.cookies.set('sid', session.id, { overwrite: true });
          ctx.done(err, { path: session.path, id: session.id, uid: session.uid });
        });
      });
    }
    
    function loginFail(err) {
      checkAndSaveUser(function () {
        if (err) return ctx.done(err); // allow overriding of error message from event
        ctx.res.statusCode = 401;
        ctx.done('bad credentials');
      });
    }
    
    if (user) {
      // a user with this username exists
      delete userClone.password;
      if (uc.checkHash(uc, user, credentials) === true) {
        domain.success = true;
        delete user.password; // make sure the password is not included in any sort of response
        
        if (uc.events.Login) {
          uc.events.Login.run(ctx, domain, loginDone);
        } else {
          loginDone();
        }
        return;
      }
    }
    
    if (uc.events.Login) {
      uc.events.Login.run(ctx, domain, loginFail);
    } else {
      loginFail();
    }
  });
};

UserCollection.prototype.getUserAndPasswordHash = function(user) {
  return crypto.createHash('md5').update(user.username + user.password).digest('hex');
};

UserCollection.prototype.handleSession = function (ctx, fn) {
  // called when any session has been created
  var session = ctx.session
    , path = this.path
    , uc = this;

  if(session && session.data && session.data.path == path && session.data.uid) {
    this.store.find({ id: session.data.uid }, function (err, user) {
      if (user) {
        var userHash = uc.getUserAndPasswordHash(user);
        delete user.password;
        // verify that the username and password haven't changed since this session was created
        if (session.data.userhash === userHash) {
          session.user = user;
        } else {
          ctx.res.setHeader('X-Session-Invalidated', 'true');
        }
      }
      fn(err);
    });
  } else {
    fn();
  }
};

UserCollection.prototype.setPassword = function (body) {
  var salt = uuid.create(UserCollection.SALT_LEN);
  body.password = salt + this.hash(body.password, salt);
};

UserCollection.prototype.hash = function (password, salt) {
  return crypto.createHmac('sha256', salt).update(password).digest('hex');
};

UserCollection.prototype.checkHash = function (uc, user, credentials) {
  var salt = user.password.substr(0, UserCollection.SALT_LEN)
    , hash = user.password.substr(UserCollection.SALT_LEN);

  return hash === uc.hash(credentials.password, salt);
};

UserCollection.label = 'Users Collection';
UserCollection.defaultPath = '/users';

UserCollection.prototype.clientGenerationGet = ['me'];
UserCollection.prototype.clientGenerationExec = ['login', 'logout'];

module.exports = UserCollection;
