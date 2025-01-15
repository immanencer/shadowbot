// nft-lister.mjs

import { MongoClient } from 'mongodb';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

// ------------------------------------------
// Load environment variables from .env file
// ------------------------------------------
dotenv.config();

// ------------------------------------------
// Environment Variables & Defaults
// ------------------------------------------
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DATABASE_NAME = process.env.DATABASE_NAME || 'solana';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'walletTokens';
const IMAGE_SAVE_PATH = process.env.IMAGE_SAVE_PATH || './nft_images';
const TRACK_WALLET = process.env.TRACK_WALLET; // Comma-separated wallet addresses

// ------------------------------------------
// Validate Key Environment Vars
// ------------------------------------------
if (!HELIUS_API_KEY) {
  console.error('Error: HELIUS_API_KEY not set in environment.');
  process.exit(1);
}
if (!TRACK_WALLET) {
  console.error('Error: TRACK_WALLET not set in environment.');
  process.exit(1);
}

/**
 * Ensures the directory for storing images exists.
 * Creates it recursively if it doesn't exist.
 */
async function ensureImageDirectory() {
  try {
    await fs.access(IMAGE_SAVE_PATH);
  } catch {
    await fs.mkdir(IMAGE_SAVE_PATH, { recursive: true });
    console.log(`[INFO] Created image directory at: ${IMAGE_SAVE_PATH}`);
  }
}

/**
 * Splits and validates a comma-separated list of wallet addresses.
 * @param {string} walletsEnv
 * @returns {string[]} Array of valid addresses
 */
function parseWalletAddresses(walletsEnv) {
  const addresses = walletsEnv
    .split(',')
    .map(addr => addr.trim())
    .filter(Boolean);

  const validAddresses = addresses.filter(addr => addr.length === 44); // Basic length check for Solana

  if (validAddresses.length === 0) {
    console.error('[ERROR] No valid wallet addresses provided.');
    process.exit(1);
  }

  return validAddresses;
}


/**
 * Fetch NFTs for a given wallet using the Helius getAssetsByOwner API.
 * @param {string} walletAddress
 * @returns {Promise<Array>} Array of processed NFT objects
 */
async function fetchNFTs(walletAddress) {
  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'fetch-assets',
        method: 'getAssetsByOwner',
        params: {
          ownerAddress: walletAddress,
          displayOptions: {
            showCollectionMetadata: true,
            showFungible: true,
            showUnverifiedCollections: true,
            showNativeBalance: true,
          },
        },
      }),
    });

    if (!response.ok) {
      console.warn(`[WARN] Failed to fetch NFTs for wallet: ${walletAddress}`);
      return [];
    }

    const { result } = await response.json();
    const assets = result?.items || [];
    if (assets.length === 0) {
      console.warn(`[WARN] No assets found for wallet: ${walletAddress}`);
      return [];
    }

    // Process each asset in parallel
    const nfts = await Promise.all(assets.map(processAsset));
    return nfts.filter(Boolean);
  } catch (error) {
    console.error(`[ERROR] Fetching NFTs for wallet ${walletAddress}:`, error);
    return [];
  }
}

/**
 * Process each asset:
 * 1. Fetch metadata JSON (if available)
 * 2. Download and save the NFT image
 * 3. Return a structured NFT object
 * @param {object} asset - An asset from the Helius response
 * @returns {Promise<object|null>}
 */
async function processAsset(asset) {
  if (!asset?.content?.json_uri) {
    console.warn(`[WARN] Missing json_uri or invalid asset: ${asset?.id || 'N/A'}`);
    return null;
  }

  try {
    const metadataURI = asset.content.json_uri;
    let metadataJSON = {};

    // Attempt to fetch the metadata
    try {
      const response = await fetch(metadataURI);
      if (response.ok) {
        metadataJSON = await response.json();
      } else {
        console.warn(`[WARN] Unable to fetch metadata from: ${metadataURI}`);
      }
    } catch (error) {
      console.warn(`[WARN] Error fetching metadata from: ${metadataURI}, ${error}`);
    }

    // Attempt to fetch and save the image
    let localImagePath = null;
    if (metadataJSON.image) {
      localImagePath = await downloadImage(asset.id, metadataJSON.image);
    }

    // Construct final NFT object
    return {
      mint: asset.id,
      name: metadataJSON.name || null,
      symbol: metadataJSON.symbol || null,
      Ca: asset.content.collection_address || null,
      uri: metadataURI,
      image: metadataJSON.image || null,
      localImagePath: localImagePath || null,
      description: metadataJSON.description || null,
      quantity: parseAssetQuantity(asset.token_info),
      price: parseAssetPrice(asset.token_info),
    };
  } catch (error) {
    console.error(`[ERROR] Processing asset ${asset?.id || 'N/A'}:`, error);
    return null;
  }
}

/**
 * Downloads an image from IPFS or URL, saves it locally, and returns the local file path.
 * @param {string} assetId
 * @param {string} imageUri
 * @returns {Promise<string|null>} Local file path or null on failure
 */
async function downloadImage(assetId, imageUri) {
  try {
    const imageUrl = imageUri.startsWith('ipfs://')
      ? `https://ipfs.io/ipfs/${imageUri.slice(7)}`
      : imageUri;

    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      console.warn(`[WARN] Failed to fetch image from: ${imageUri}`);
      return null;
    }

    const buffer = await imageResponse.buffer();
    const imageExtension = path.extname(new URL(imageUrl).pathname) || '.jpg';
    const fileName = `${assetId}${imageExtension}`;
    const localPath = path.join(IMAGE_SAVE_PATH, fileName);

    await fs.writeFile(localPath, buffer);
    return localPath;
  } catch (error) {
    console.warn(`[WARN] Error downloading image from ${imageUri}:`, error);
    return null;
  }
}

/**
 * Parse quantity from token_info, default to 1 if undefined
 * @param {object} tokenInfo
 * @returns {number}
 */
function parseAssetQuantity(tokenInfo) {
  if (!tokenInfo) return 1;
  const { balance, decimals } = tokenInfo;
  return balance && decimals >= 0
    ? parseFloat(balance) / 10 ** decimals
    : 1;
}

/**
 * Parse price from token_info, default to 0 if undefined
 * @param {object} tokenInfo
 * @returns {number}
 */
function parseAssetPrice(tokenInfo) {
  if (!tokenInfo) return 0;
  return parseFloat(tokenInfo.price) || 0;
}

/**
 * Updates MongoDB with the NFT list for a specific wallet.
 * Also generates a simplified markdown report.
 * @param {string} walletAddress
 * @param {Array} nfts
 * @returns {Promise<void>}
 */
async function updateMongoDB(walletAddress, nfts) {
  const client = new MongoClient(MONGODB_URI, {
    useUnifiedTopology: true,
    // Add other advanced options in production as needed
  });

  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const collection = db.collection(COLLECTION_NAME);

    // Upsert the wallet document
    const walletDoc = {
      walletAddress,
      nfts,
      lastUpdated: new Date(),
    };
    await collection.updateOne(
      { walletAddress },
      { $set: walletDoc },
      { upsert: true }
    );

    // Generate and save the markdown report
    const markdownReport = createMarkdownReport(walletAddress, nfts);
    const reportFileName = `${walletAddress}_report.md`;
    const reportPath = path.join(IMAGE_SAVE_PATH, reportFileName);

    await fs.writeFile(reportPath, markdownReport);
    console.log(`[INFO] Markdown report saved: ${reportPath}`);
  } catch (error) {
    console.error(`[ERROR] Updating MongoDB for wallet ${walletAddress}:`, error);
  } finally {
    await client.close();
  }
}

/**
 * Creates a simplified markdown report listing NFTs (and fungible tokens if present).
 * @param {string} walletAddress
 * @param {Array} nfts
 * @returns {string} Markdown content
 */
function createMarkdownReport(walletAddress, nfts) {
  let report = `# Asset Report for Wallet: \`${walletAddress}\`\n\n`;

  const nftsOnly = nfts.filter(nft => !nft.symbol || nft.symbol.toUpperCase() === 'N/A');
  const fungibleTokens = nfts.filter(nft => nft.symbol && nft.symbol.toUpperCase() !== 'N/A');

  if (nftsOnly.length > 0) {
    report += `## NFTs\n\n`;
    nftsOnly.forEach((nft, idx) => {
      const fileName = nft.localImagePath ? nft.localImagePath.split('/').pop() : 'Unknown';
      report += `**NFT ${idx + 1}:** ${nft.name || 'Unnamed NFT'}\n\n`;
      report += `- Mint: \`${nft.mint}\`\n`;
      report += `- Description: ${nft.description || 'N/A'}\n`;
      report += `- Image URL: ${nft.image || 'N/A'}\n`;
      report += `- File: \`${fileName}\`\n`;
      report += `\n`;
    });
  } else {
    report += `## NFTs\n\nNo NFTs found.\n\n`;
  }

  if (fungibleTokens.length > 0) {
    report += `## Fungible Tokens\n\n`;
    fungibleTokens.forEach((token, idx) => {
      report += `**Token ${idx + 1}:** ${token.name || 'N/A'}\n\n`;
      report += `- Symbol: \`${token.symbol || 'N/A'}\`\n`;
      report += `- Quantity: \`${token.quantity}\`\n`;
      report += `- Price: \`${token.price}\`\n`;
      report += `\n`;
    });
  }

  return report;
}

/**
 * Main execution function
 * 1. Ensure image directory exists
 * 2. Parse wallets from environment
 * 3. For each wallet, fetch NFTs and update DB
 */
async function processWallets() {
  await ensureImageDirectory();

  const walletAddresses = parseWalletAddresses(TRACK_WALLET);

  for (const wallet of walletAddresses) {
    console.log(`\n---\nProcessing wallet: ${wallet}\n---`);
    const nfts = await fetchNFTs(wallet);
    console.log(`[INFO] Found ${nfts.length} assets for wallet: ${wallet}`);

    await updateMongoDB(wallet, nfts);
  }

  console.log('\n[INFO] All wallets processed successfully.');
}

export function updateSolanaAssets () {
// Invoke main process
processWallets().catch(error => {
  console.error('[FATAL] Unexpected error during processing:', error);
  process.exit(1);
});
}
