'use strict';
const crypto = require('node:crypto');

class ImageSaveAuthorizations {
  constructor(now = Date.now) {
    this.now = now;
    this.grants = new Map();
  }

  authorize(windowId, filePath) {
    const now = this.now();
    for (const [token, grant] of this.grants) {
      if (grant.windowId === windowId || grant.expiresAt <= now) this.grants.delete(token);
    }
    const token = crypto.randomUUID();
    this.grants.set(token, {windowId, filePath, expiresAt: now + 10 * 60 * 1000});
    return token;
  }

  consume(windowId, filePath, token) {
    const grant = this.grants.get(token);
    if (!grant || grant.windowId !== windowId || grant.filePath !== filePath || grant.expiresAt <= this.now()) {
      throw new Error('图片保存授权无效、已过期或路径/窗口不匹配，请重新选择保存位置。');
    }
    this.grants.delete(token);
  }
}

module.exports = ImageSaveAuthorizations;
