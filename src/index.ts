import * as fs from 'fs';
import {getPem} from 'google-p12-pem';
import * as jws from 'jws';
import * as mime from 'mime';
import * as pify from 'pify';
import * as querystring from 'querystring';
import fetch from 'node-fetch';
import { Agent } from "https";

const readFile = pify(fs.readFile);

const GOOGLE_TOKEN_URL = 'https://www.googleapis.com/oauth2/v4/token';
const GOOGLE_REVOKE_TOKEN_URL =
    'https://accounts.google.com/o/oauth2/revoke?token=';

interface Payload {
  iss: string;
  scope: string|string[];
  aud: string;
  exp: number;
  iat: number;
  sub: string;
}

export interface TokenOptions {
  keyFile?: string;
  key?: string;
  email?: string;
  iss?: string;
  sub?: string;
  scope?: string|string[];
  additionalClaims?: {};
  agent?: Agent;
}

class ErrorWithCode extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

export class GoogleToken {
  token: string|null = null;
  expiresAt: number|null = null;
  key?: string;
  keyFile?: string;
  iss?: string;
  sub?: string;
  scope?: string;
  rawToken: string|null = null;
  tokenExpires: number|null = null;
  email?: string;
  agent?: Agent;
  additionalClaims?: {};

  /**
   * Create a GoogleToken.
   *
   * @param options  Configuration object.
   */
  constructor(options?: TokenOptions) {
    this.configure(options);
  }

  /**
   * Returns whether the token has expired.
   *
   * @return true if the token has expired, false otherwise.
   */
  hasExpired() {
    const now = (new Date()).getTime();
    if (this.token && this.expiresAt) {
      return now >= this.expiresAt;
    } else {
      return true;
    }
  }

  /**
   * Returns a cached token or retrieves a new one from Google.
   *
   * @param callback The callback function.
   */
  getToken(): Promise<string|null>;
  getToken(callback: (err: Error|null, token?: string|null) => void): void;
  getToken(callback?: (err: Error|null, token?: string|null) => void):
      void|Promise<string|null> {
    if (callback) {
      this.getTokenAsync()
          .then(t => {
            callback(null, t);
          })
          .catch(callback);
      return;
    }
    return this.getTokenAsync();
  }

  private async getTokenAsync() {
    if (!this.hasExpired()) {
      return Promise.resolve(this.token);
    }

    if (!this.key && !this.keyFile) {
      throw new Error('No key or keyFile set.');
    }

    if (!this.key && this.keyFile) {
      const mimeType = mime.getType(this.keyFile);
      switch (mimeType) {
        case 'application/json': {
          // *.json file
          const key = await readFile(this.keyFile, 'utf8');
          const body = JSON.parse(key);
          this.key = body.private_key;
          this.iss = body.client_email;
          if (!this.key || !this.iss) {
            throw new ErrorWithCode(
                'private_key and client_email are required.',
                'MISSING_CREDENTIALS');
          }
          break;
        }
        case 'application/x-x509-ca-cert': {
          // *.pem file
          this.ensureEmail();
          this.key = await readFile(this.keyFile, 'utf8');
          break;
        }
        case 'application/x-pkcs12': {
          // *.p12 file
          this.ensureEmail();
          this.key = await getPem(this.keyFile);
          break;
        }
        default:
          throw new ErrorWithCode(
              'Unknown certificate type. Type is determined based on file extension.  Current supported extensions are *.json, *.pem, and *.p12.',
              'UNKNOWN_CERTIFICATE_TYPE');
      }
    }
    return this.requestToken();
  }

  private ensureEmail() {
    if (!this.iss) {
      throw new ErrorWithCode('email is required.', 'MISSING_CREDENTIALS');
    }
  }

  /**
   * Revoke the token if one is set.
   *
   * @param callback The callback function.
   */
  revokeToken(): Promise<void>;
  revokeToken(callback: (err?: Error) => void): void;
  revokeToken(callback?: (err?: Error) => void): void|Promise<void> {
    if (callback) {
      this.revokeTokenAsync().then(() => callback()).catch(callback);
      return;
    }
    return this.revokeTokenAsync();
  }

  private async revokeTokenAsync() {
    if (!this.token) {
      throw new Error('No token to revoke.');
    }
    return fetch(GOOGLE_REVOKE_TOKEN_URL + this.token, { agent: this.agent }).then(r => {
      this.configure({
        email: this.iss,
        sub: this.sub,
        key: this.key,
        keyFile: this.keyFile,
        scope: this.scope,
        additionalClaims: this.additionalClaims,
      });
    });
  }


  /**
   * Configure the GoogleToken for re-use.
   * @param  {object} options Configuration object.
   */
  private configure(options: TokenOptions = {}) {
    this.keyFile = options.keyFile;
    this.key = options.key;
    this.token = this.expiresAt = this.rawToken = null;
    this.iss = options.email || options.iss;
    this.sub = options.sub;
    this.additionalClaims = options.additionalClaims;
    
    if (options.agent) {
      this.agent = options.agent
    }

    if (typeof options.scope === 'object') {
      this.scope = options.scope.join(' ');
    } else {
      this.scope = options.scope;
    }
  }

  /**
   * Request the token from Google.
   */
  private async requestToken() {
    const iat = Math.floor(new Date().getTime() / 1000);
    const additionalClaims = this.additionalClaims || {};
    const payload = Object.assign(
        {
          iss: this.iss,
          scope: this.scope,
          aud: GOOGLE_TOKEN_URL,
          exp: iat + 3600,
          iat,
          sub: this.sub
        },
        additionalClaims);
    const signedJWT =
        jws.sign({header: {alg: 'RS256'}, payload, secret: this.key});
    return fetch(GOOGLE_TOKEN_URL, {
      body: querystring.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedJWT
      }),
            agent: this.agent,
             method: 'POST',
             headers: {'Content-Type': 'application/x-www-form-urlencoded'}
           })
        .then(r => {
          return r.json()
        })
           
        .then(body=> {
          this.rawToken = body;
          this.token = body.access_token;
          this.expiresAt = (iat + body.expires_in) * 1000;
          return this.token;
        })
        .catch(e => {
          this.token = null;
          this.tokenExpires = null;
          const body = (e.response && e.response.data) ? e.response.data : {};
          let err = e;
          if (body.error) {
            const desc =
                body.error_description ? `: ${body.error_description}` : '';
            err = new Error(`${body.error}${desc}`);
          }
          throw err;
        });
  }
}
