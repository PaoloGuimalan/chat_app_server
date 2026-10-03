/**
 * The storage layer the direct-upload flow talks to.
 *
 * Every operation the platform needs from a file store, and nothing else:
 *
 *   singleUploadTarget  a presigned PUT for a whole file
 *   startMultipart / partTargets / completeMultipart / abortMultipart
 *   head / readStart / remove
 *   publicUrl / keyFromUrl
 *
 * Clients never learn which store this is: an upload target is just
 * { method, url, headers } for them to replay. So moving to another store
 * that speaks the S3 protocol (AWS S3, Cloudflare R2, Backblaze B2, Wasabi,
 * MinIO, Google Cloud Storage's S3 mode) is a change of environment variables;
 * one that doesn't needs a second class with these same methods, and nothing
 * outside this file changes.
 *
 * Public links are built from STORAGE_PUBLIC_BASE_URL (our own media domain),
 * so a stored link never names the provider - a move is copying the files and
 * pointing the domain elsewhere. Uploads cannot go through that domain
 * (presigned URLs must use the origin endpoint), which clients never notice.
 *
 * Environment (STORAGE_* first, the existing SPACES_* as fallback):
 *   STORAGE_PROVIDER         name recorded on each file (default digitalocean)
 *   STORAGE_ENDPOINT         origin API endpoint, e.g. https://sgp1.digitaloceanspaces.com
 *   STORAGE_REGION           signing region
 *   STORAGE_BUCKET
 *   STORAGE_KEY / STORAGE_SECRET
 *   STORAGE_CDN_ENDPOINT     the provider's CDN host, for recognising older links
 *   STORAGE_PUBLIC_BASE_URL  e.g. https://media.neonsystems.net
 */
require("dotenv").config();
const {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const env = (name) => process.env[`STORAGE_${name}`] || process.env[`SPACES_${name}`];

/** Encodes each path segment, keeping the slashes. */
const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");

const decodeSegment = (segment) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    // An older link stored a raw name with a literal "%" in it.
    return segment;
  }
};

const stripSlash = (value) => String(value || "").replace(/\/+$/, "");

// How long an upload link stays valid. Long enough for a big part on a slow
// connection; an expired part is re-signed through /media/uploads/:id/parts.
const UPLOAD_LINK_SECONDS = 60 * 60;

class S3CompatibleStorage {
  constructor(config) {
    this.name = config.name;
    this.bucket = config.bucket;
    this.endpoint = stripSlash(config.endpoint);
    this.cdnEndpoint = config.cdnEndpoint;
    this.publicBaseUrl = stripSlash(
      config.publicBaseUrl ||
        (config.cdnEndpoint ? `https://${config.bucket}.${config.cdnEndpoint}` : ""),
    );
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region || "us-east-1",
      credentials: { accessKeyId: config.key || "", secretAccessKey: config.secret || "" },
    });
  }

  publicUrl(key) {
    return `${this.publicBaseUrl}/${encodeKey(key)}`;
  }

  /**
   * The key a link of ours points at - ours meaning this bucket through the
   * media domain, the provider's CDN host, or the origin (either addressing
   * style). Null for anything else: other buckets, Firebase, pasted links.
   */
  keyFromUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      return null;
    }
    const host = parsed.host.toLowerCase();
    const originHost = this.endpoint ? new URL(this.endpoint).host.toLowerCase() : null;
    const bases = new Set(
      [
        this.publicBaseUrl && new URL(this.publicBaseUrl).host.toLowerCase(),
        this.cdnEndpoint && `${this.bucket}.${this.cdnEndpoint}`.toLowerCase(),
        originHost && `${this.bucket}.${originHost}`.toLowerCase(),
      ].filter(Boolean),
    );

    let path = parsed.pathname;
    if (!bases.has(host)) {
      // Path-style origin URL: https://<origin>/<bucket>/<key>
      if (!originHost || host !== originHost) return null;
      const prefix = `/${this.bucket}/`;
      if (!path.startsWith(prefix)) return null;
      path = path.slice(prefix.length - 1);
    }
    const key = path.replace(/^\/+/, "").split("/").map(decodeSegment).join("/");
    return key || null;
  }

  async singleUploadTarget({ key, contentType, disposition, size }) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentDisposition: disposition,
      ContentLength: size,
      ACL: "public-read",
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: UPLOAD_LINK_SECONDS,
      // Signed, so storage itself refuses a different type or size. The S3
      // presigner leaves content-type unsigned unless told otherwise.
      signableHeaders: new Set(["content-type", "content-disposition", "content-length"]),
    });
    return {
      method: "PUT",
      url,
      // What the client must send with it. Content-Length is set by every
      // HTTP client from the body itself.
      headers: { "Content-Type": contentType, "Content-Disposition": disposition },
    };
  }

  async startMultipart({ key, contentType, disposition }) {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentDisposition: disposition,
        ACL: "public-read",
      }),
    );
    return result.UploadId;
  }

  /** One presigned PUT per part; `parts` is [{ n, size }]. */
  async partTargets({ key, uploadId, parts }) {
    return Promise.all(
      parts.map(async ({ n, size }) => ({
        n,
        size,
        method: "PUT",
        url: await getSignedUrl(
          this.client,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: n,
            ContentLength: size,
          }),
          {
            expiresIn: UPLOAD_LINK_SECONDS,
            signableHeaders: new Set(["content-length"]),
          },
        ),
        headers: {},
      })),
    );
  }

  /** `parts` is [{ n, etag }], any order. */
  async completeMultipart({ key, uploadId, parts }) {
    const sorted = [...parts].sort((a, b) => a.n - b.n);
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sorted.map((p) => ({ PartNumber: p.n, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipart({ key, uploadId }) {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (err) {
      // Already completed or aborted - nothing left to clean up.
      if (!/NoSuchUpload/i.test(err.name || err.Code || "")) throw err;
    }
  }

  /** { size, contentType } of a stored file, or null if there is none. */
  async head(key) {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { size: Number(result.ContentLength), contentType: result.ContentType };
    } catch (err) {
      if (err.$metadata?.httpStatusCode === 404 || /NotFound|NoSuchKey/i.test(err.name)) {
        return null;
      }
      throw err;
    }
  }

  /** The first `bytes` bytes of a stored file. */
  async readStart(key, bytes) {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
    );
    return Buffer.from(await result.Body.transformToByteArray());
  }

  /** Deleting a missing key succeeds, as S3 itself treats it. */
  async remove(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

const storage = new S3CompatibleStorage({
  name: env("PROVIDER") || process.env.STORAGE_PROVIDER || "digitalocean",
  endpoint: env("ENDPOINT"),
  region: env("REGION"),
  bucket: env("BUCKET"),
  key: env("KEY"),
  secret: env("SECRET"),
  cdnEndpoint: env("CDN_ENDPOINT"),
  publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL,
});

module.exports = storage;
module.exports.S3CompatibleStorage = S3CompatibleStorage;
module.exports.encodeKey = encodeKey;
