require("dotenv").config();
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const makeid = require("./makeID");
const { saveFileRecordToDatabase } = require("./firebaseupload");
const fileTypeMime = require("file-type-mime");

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

  async upload(referenceID, fileBuffer, fileName, details, folder = "uploads") {
    const detectedType = fileTypeMime.parse(fileBuffer);

    const mimeType = detectedType
      ? detectedType.mime
      : "application/octet-stream";

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${folder}/${fileName}`, // Auto-creates "folders"
      Body: fileBuffer,
      ACL: "public-read", // Optional: makes it accessible via CDN URL
    });
    await this.client.send(command);

    const fileUrl = `https://${this.bucket}.${this.cdnEndpoint}/${folder}/${fileName}`;

    const uniqueReferenceIDs = [
      ...new Set([...details.referenceIDs, referenceID]),
    ];

    const result = await saveFileRecordToDatabase(
      uniqueReferenceIDs,
      fileUrl,
      details.action,
      mimeType,
      "digitalocean",
      fileName,
    );

    return result;
  }

  async uploadBase64(
    referenceID,
    base64WithHeader,
    customName,
    details,
    folder = "uploads",
  ) {
    const matches = base64WithHeader.match(
      /^data:([^/]+)\/([^;]+);base64,(.+)$/,
    );

    if (!matches) {
      throw new Error("Invalid Base64 format: Missing Data URL header");
    }

    const topType = matches[1];
    const subtype = matches[2];
    const rawData = matches[3];

    const mimeType = `${topType}/${subtype}`;
    const buffer = Buffer.from(rawData, "base64");

    const fileName = customName.includes(".")
      ? `${makeid(10)}_${customName}`
      : `${makeid(10)}_${customName}.${subtype}`;

    const isViewable = ["image", "video"].includes(topType);
    const disposition = isViewable
      ? "inline"
      : `attachment; filename="${fileName}"`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${folder}/${fileName}`,
      Body: buffer,
      ContentDisposition: disposition,
      ContentType: mimeType,
      ACL: "public-read",
    });

    await this.client.send(command);

    const fileUrl = `https://${this.bucket}.${this.cdnEndpoint}/${folder}/${fileName}`;

    const uniqueReferenceIDs = [
      ...new Set([...details.referenceIDs, referenceID]),
    ];

    const result = await saveFileRecordToDatabase(
      uniqueReferenceIDs,
      fileUrl,
      details.action,
      mimeType,
      "digitalocean",
      customName,
    );

    return result;
  }

  async uploadMultipleBase64(filesArray, details, folder = "uploads") {
    const uploadPromises = filesArray.map(async (file) => {
      // Perform the upload using the existing base64 string
      const metadata = await this.uploadBase64(
        file.referenceID,
        file.reference,
        file.name,
        details,
        folder,
      );

      return {
        ...file,
        ...metadata,
        reference: metadata.fileDetails.data,
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
