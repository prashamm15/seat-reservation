'use strict';

class AppError extends Error {
  constructor(statusCode, code, message, extra) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra || {};
  }
}

module.exports = { AppError };
