import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { CohereEmbeddings } from "@langchain/cohere";
import { CloudClient } from "chromadb";
import { Document } from "@langchain/core/documents";

dotenv.config();

const {
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  S3_BUCKET,
  COHERE_API_KEY,
  CHROMA_API_KEY,
  CHROMA_TENANT,
  CHROMA_DATABASE,
} = process.env;

if (!S3_BUCKET || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
  throw new Error("❌ Missing AWS credentials or S3 bucket name in .env");
}

if (!COHERE_API_KEY) {
  throw new Error("❌ Missing COHERE_API_KEY in .env");
}

if (!CHROMA_API_KEY || !CHROMA_TENANT || !CHROMA_DATABASE) {
  throw new Error("❌ Missing ChromaDB cloud credentials in .env");
}

// ---------- AWS S3 Setup ----------
const s3 = new S3Client({
  region: AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

// Function to list *all* objects in the S3 bucket (even >1000)
async function listAllObjects(bucketName) {
  let keys = [];
  let ContinuationToken = undefined;

  while (true) {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken,
      })
    );

    if (response.Contents) {
      keys.push(...response.Contents.map((item) => item.Key));
    }

    if (!response.IsTruncated) break;
    ContinuationToken = response.NextContinuationToken;
  }

  return keys.filter(Boolean);
}

// Function to load CSV content from S3
async function loadCSVFromS3(bucket, key) {
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }));
    
    const csvContent = await response.Body.transformToString();
    
    // Simple CSV parsing - convert to text format
    const lines = csvContent.split('\n');
    const headers = lines[0];
    const rows = lines.slice(1).filter(row => row.trim());
    
    let content = `File: ${key}\nHeaders: ${headers}\n\nData:\n`;
    rows.forEach((row, index) => {
      if (row.trim() && index < 100) { // Limit to first 100 rows
        content += `Row ${index + 1}: ${row}\n`;
      }
    });
    
    return new Document({
      pageContent: content,
      metadata: {
        source: `s3://${bucket}/${key}`,
        type: 'csv',
        rows: rows.length
      }
    });
  } catch (error) {
    console.error(`Error loading ${key}:`, error.message);
    return null;
  }
}

// ---------- Main ingestion ----------
async function ingestAllFromS3() {
  console.log(`📦 Listing all files from S3 bucket: ${S3_BUCKET} ...`);
  const keys = await listAllObjects(S3_BUCKET);
  console.log(`✅ Found ${keys.length} files in S3 bucket.`);

  const embeddings = new CohereEmbeddings({ 
    apiKey: COHERE_API_KEY,
    model: "embed-english-v3.0"
  });
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  // Initialize ChromaDB cloud client
  const client = new CloudClient({
    apiKey: CHROMA_API_KEY,
    tenant: CHROMA_TENANT,
    database: CHROMA_DATABASE
  });

  // Get or create collection
  let collection;
  try {
    collection = await client.getCollection({
      name: "farming-documents"
    });
    console.log("✅ Using existing collection: farming-documents");
  } catch (error) {
    // Create collection without embedding function (we handle embeddings externally)
    collection = await client.createCollection({
      name: "farming-documents",
      metadata: { 
        description: "Agricultural data for Tamil Nadu farming assistant",
        embedding_provider: "cohere" 
      }
    });
    console.log("✅ Created new collection: farming-documents");
  }

  for (const key of keys) {
    try {
      console.log(`\n🔹 Processing: ${key}`);

      // Load document from S3 using our custom CSV loader
      const doc = await loadCSVFromS3(S3_BUCKET, key);
      if (!doc) {
        console.warn(`⚠️ Failed to load: ${key}`);
        continue;
      }

      // Split into chunks
      const splitDocs = await textSplitter.splitDocuments([doc]);
      console.log(`📄 Split into ${splitDocs.length} chunks.`);

      if (splitDocs.length === 0) {
        console.warn(`⚠️ No chunks created for: ${key}`);
        continue;
      }

      // Generate embeddings for chunks
      const documents = [];
      const metadatas = [];
      const ids = [];

      for (let i = 0; i < splitDocs.length; i++) {
        const chunk = splitDocs[i];
        documents.push(chunk.pageContent);
        metadatas.push({
          source: `s3://${S3_BUCKET}/${key}`,
          chunk_index: i,
          filename: key
        });
        ids.push(`${key}_chunk_${i}_${Date.now()}`);
      }

      // Get embeddings from Cohere
      const embeddingResults = await embeddings.embedDocuments(documents);

      // Add to ChromaDB collection
      await collection.add({
        ids: ids,
        embeddings: embeddingResults,
        metadatas: metadatas,
        documents: documents
      });

      console.log(`✅ Added ${key} with ${splitDocs.length} chunks to ChromaDB cloud.`);
    } catch (err) {
      console.error(`❌ Error processing ${key}:`, err.message);
    }
  }

  console.log("\n🎉 All S3 files ingested successfully!");
}

// Run the ingestion
ingestAllFromS3().catch((err) => {
  console.error("Fatal ingestion error:", err);
  process.exit(1);
});
