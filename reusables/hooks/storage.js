require("dotenv").config();
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const makeid = require("./makeID");

class S3StorageProvider {
  constructor(config) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.key,
        secretAccessKey: config.secret,
      },
    });
    this.bucket = config.bucket;
    this.cdnEndpoint = config.cdnEndpoint;
    this.testConnection(config.name);
  }

  async testConnection(provider) {
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        MaxKeys: 1,
      });
      await this.client.send(command);
      console.log(
        `Storage: Successfully connected to ${provider} (${this.bucket})`,
      );
    } catch (err) {
      console.error(
        `Storage: Failed to connect to ${provider}. Check your .env credentials.`,
      );
      console.error(`Error details: ${err.message}`);
    }
  }

  async upload(fileName, fileBuffer, folder = "uploads") {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${folder}/${fileName}`, // Auto-creates "folders"
      Body: fileBuffer,
      ACL: "public-read", // Optional: makes it accessible via CDN URL
    });
    await this.client.send(command);

    return `https://${this.bucket}.${this.cdnEndpoint}/${folder}/${fileName}`;
  }

  async uploadBase64(base64WithHeader, customName, folder = "uploads") {
    const matches = base64WithHeader.match(
      /^data:([^/]+)\/([^;]+);base64,(.+)$/,
    );

    if (!matches) {
      throw new Error("Invalid Base64 format: Missing Data URL header");
    }

    const contentType = matches[1]; // e.g., "image/png"
    const extension = matches[2]; // e.g., "png"
    const rawData = matches[3]; // The actual encoded string

    const buffer = Buffer.from(rawData, "base64");

    const fileName = customName.includes(".")
      ? `${makeid(10)}_${customName}`
      : `${makeid(10)}_${customName}.${extension}`;

    const isViewable = ["image", "video"].includes(contentType);
    const disposition = isViewable
      ? "inline"
      : `attachment; filename="${fileName}"`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${folder}/${fileName}`,
      Body: buffer,
      ContentDisposition: disposition,
      ContentType: contentType,
      ACL: "public-read",
    });

    await this.client.send(command);

    return `https://${this.bucket}.${this.cdnEndpoint}/${folder}/${fileName}`;
  }

  async uploadMultipleBase64(filesArray, folder = "uploads") {
    const uploadPromises = filesArray.map(async (file) => {
      // Perform the upload using the existing base64 string
      const fileUrl = await this.uploadBase64(
        file.reference,
        file.name,
        folder,
      );

      return {
        ...file,
        reference: fileUrl,
      };
    });

    const results = await Promise.all(uploadPromises);

    return results;
  }
}

// The Factory: Change one variable to switch providers
const storageConfig = {
  provider: process.env.STORAGE_PROVIDER || "digitalocean",
  digitalocean: {
    name: "digitalocean",
    endpoint: process.env.SPACES_ENDPOINT,
    cdnEndpoint: process.env.SPACES_CDN_ENDPOINT,
    region: process.env.SPACES_REGION,
    bucket: process.env.SPACES_BUCKET,
    key: process.env.SPACES_KEY,
    secret: process.env.SPACES_SECRET,
  },
  aws: {
    name: "s3",
    endpoint: undefined, // AWS SDK handles this automatically for S3
    region: "us-east-1",
    bucket: "my-aws-bucket",
    key: process.env.AWS_KEY,
    secret: process.env.AWS_SECRET,
  },
};

const providerConfig = storageConfig[storageConfig.provider];
const Storage = new S3StorageProvider(providerConfig);

module.exports = Storage;
