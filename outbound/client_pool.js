"use strict";

const generic_pool = require('generic-pool');

const sock         = require('../line_socket');
const server       = require('../server');
const logger       = require('../logger');

const cfg          = require('./config');

let socket_idx = 0;

function _create_socket (pool_name, port, host, local_addr, is_unix_socket, callback) {
    const socket = is_unix_socket ? sock.connect({path: host}) :
        sock.connect({port: port, host: host, localAddress: local_addr});
    socket.__pool_name = pool_name;
    socket.__sock_idx = ++socket_idx;
    socket.setTimeout(cfg.connect_timeout * 1000);
    logger.logdebug(
        '[outbound] created',
        {
            idx: socket_idx,
            host: host,
            port: port,
            pool_timeout: cfg.pool_timeout
        }
    );
    socket.once('connect', function () {
        socket.removeAllListeners('error'); // these get added after callback
        socket.removeAllListeners('timeout');
        callback(null, socket);
    });
    socket.once('error', function (err) {
        socket.end();
        callback(`Outbound connection error: ${err}`, null);
    });
    socket.once('timeout', function () {
        socket.end();
        callback(`Outbound connection timed out to ${host}:${port}`, null);
    });
}

// Separate pools are kept for each set of server attributes.
function get_pool (port, host, local_addr, is_unix_socket, max) {
    port = port || 25;
    host = host || 'localhost';
    const name = `outbound::${port}:${host}:${local_addr}:${cfg.pool_timeout}`;
    if (!server.notes.pool) {
        server.notes.pool = {};
    }
    if (!server.notes.pool[name]) {
        const pool = generic_pool.Pool({
            name: name,
            create: function (done) {
                _create_socket(this.name, port, host, local_addr, is_unix_socket, done);
            },
            validate: function (socket) {
                return socket.__fromPool && socket.writable;
            },
            destroy: function (socket) {
                logger.logdebug(`[outbound] destroying pool entry ${socket.__sock_idx} for ${host}:${port}`);
                socket.removeAllListeners();
                socket.__fromPool = false;
                socket.on('line', function (line) {
                    // Just assume this is a valid response
                    logger.logprotocol(`[outbound] S: ${line}`);
                });
                socket.once('error', function (err) {
                    logger.logwarn(`[outbound] Socket got an error while shutting down: ${err}`);
                });
                socket.once('end', function () {
                    logger.loginfo("[outbound] Remote end half closed during destroy()");
                    socket.destroy();
                })
                if (socket.writable) {
                    logger.logprotocol("[outbound] C: QUIT");
                    socket.write("QUIT\r\n");
                }
                socket.end(); // half close
            },
            max: max || 10,
            idleTimeoutMillis: cfg.pool_timeout * 1000,
            log: function (str, level) {
                if (/this._availableObjects.length=/.test(str)) return;
                level = (level === 'verbose') ? 'debug' : level;
                logger[`log${level}`](`[outbound] [${name}] ${str}`);
            }
        });
        server.notes.pool[name] = pool;
    }
    return server.notes.pool[name];
}

// Get a socket for the given attributes.
exports.get_client = function (port, host, local_addr, is_unix_socket, callback) {
    if (cfg.pool_concurrency_max == 0) {
        return _create_socket(null, port, host, local_addr, is_unix_socket, callback);
    }

    const pool = get_pool(port, host, local_addr, is_unix_socket, cfg.pool_concurrency_max);
    if (pool.waitingClientsCount() >= cfg.pool_concurrency_max) {
        return callback("Too many waiting clients for pool", null);
    }
    pool.acquire(function (err, socket) {
        if (err) return callback(err);
        socket.__acquired = true;
        logger.loginfo(`[outbound] acquired socket ${socket.__sock_idx} for ${socket.__pool_name}`);
        callback(null, socket);
    });
}

exports.release_client = function (socket, port, host, local_addr, error) {
    logger.logdebug(`[outbound] release_client: ${socket.__sock_idx} ${host}:${port} to ${local_addr}`);

    const name = socket.__pool_name;

    if (!name && cfg.pool_concurrency_max == 0) {
        return sockend();
    }

    if (!socket.__acquired) {
        logger.logwarn(`Release an un-acquired socket. Stack: ${(new Error()).stack}`);
        return;
    }
    socket.__acquired = false;

    if (!(server.notes && server.notes.pool)) {
        logger.logcrit(`[outbound] Releasing a pool (${name}) that doesn't exist!`);
        return;
    }
    const pool = server.notes.pool[name];
    if (!pool) {
        logger.logcrit(`[outbound] Releasing a pool (${name}) that doesn't exist!`);
        return;
    }

    if (error) {
        return sockend();
    }

    if (cfg.pool_timeout == 0) {
        logger.loginfo("[outbound] Pool_timeout is zero - shutting it down");
        return sockend();
    }

    socket.removeAllListeners('close');
    socket.removeAllListeners('error');
    socket.removeAllListeners('end');
    socket.removeAllListeners('timeout');
    socket.removeAllListeners('line');

    socket.__fromPool = true;

    socket.once('error', function (err) {
        logger.logwarn(`[outbound] Socket [${name}] in pool got an error: ${err}`);
        sockend();
    });

    socket.once('end', function () {
        logger.loginfo(`[outbound] Socket [${name}] in pool got FIN`);
        socket.writable = false;
        sockend();
    });

    pool.release(socket);

    function sockend () {
        socket.__fromPool = false;
        if (server.notes.pool && server.notes.pool[name]) {
            server.notes.pool[name].destroy(socket);
        } else {
            socket.removeAllListeners();
            socket.destroy();
        }
    }
}

exports.drain_pools = function () {
    if (!server.notes.pool || Object.keys(server.notes.pool).length == 0) {
        return logger.logdebug("[outbound] Drain pools: No pools available");
    }
    Object.keys(server.notes.pool).forEach(function (p) {
        logger.logdebug(`[outbound] Drain pools: Draining SMTP connection pool ${p}`);
        server.notes.pool[p].drain(function () {
            if (!server.notes.pool[p]) return;
            server.notes.pool[p].destroyAllNow();
            delete server.notes.pool[p];
        });
    });
    logger.logdebug("[outbound] Drain pools: Pools shut down");
}
