const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

loadDotEnvFile(path.resolve(__dirname, '..', '.env'));

const { getAbi, getProtocolConfig } = require('../dist/utils/config.js');
const {
  clearWalletUniswapV4InventoryCache,
  getWalletUniswapV4Inventory,
} = require('../dist/utils/uniswap-v4-inventory.js');
const { UniswapV4WbtcUsdcRewardsAdapter } = require('../dist/adapters/uniswap-v4-wbtc-usdc-rewards.js');
const { ARBITRUM_CHAIN_ID } = require('../dist/utils/ethereum.js');
const { closePool } = require('../dist/utils/db.js');
const { getActiveRPCProvidersForChain } = require('../dist/models/rpc-provider.js');

const DEFAULT_URL = 'https://app.uniswap.org/positions/v4/arbitrum/146749';
const DEFAULT_PROTOCOL_KEY = 'uniswap-v4-wbtc-usdc-rewards';
// Keep these defaults aligned with config/protocols.json.
const OFFICIAL_ARBITRUM_V4 = {
  positionManager: '0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869',
  stateView: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990',
  poolManager: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32',
  currency0: '0x2f2a2543B76A4166549F7aab2e75Bef0aefC5B0f',
  currency1: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
};

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    if (process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    protocolKey: DEFAULT_PROTOCOL_KEY,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url' && argv[i + 1]) {
      options.url = argv[++i];
      continue;
    }
    if (arg === '--protocol-key' && argv[i + 1]) {
      options.protocolKey = argv[++i];
      continue;
    }
    if (arg === '--token-id' && argv[i + 1]) {
      options.tokenId = argv[++i];
      continue;
    }
  }

  return options;
}

function parsePositionUrl(url) {
  const match = url.match(/\/positions\/v4\/([^/]+)\/(\d+)/u);
  if (!match) {
    throw new Error(`Could not parse chain/tokenId from URL: ${url}`);
  }

  return {
    chain: match[1].toLowerCase(),
    tokenId: match[2],
  };
}

function getArbitrumEnvProviders() {
  const providers = [];
  const multiUrls = process.env.ARBITRUM_RPC_URLS
    ? process.env.ARBITRUM_RPC_URLS.split(',').map((url) => url.trim()).filter(Boolean)
    : [];

  multiUrls.forEach((url, index) => {
    providers.push({
      name: `env:ARBITRUM_RPC_URLS[${index}]`,
      url,
      source: 'env',
    });
  });

  if (process.env.ARBITRUM_RPC_URL) {
    providers.push({
      name: 'env:ARBITRUM_RPC_URL',
      url: process.env.ARBITRUM_RPC_URL.trim(),
      source: 'env',
    });
  }

  return providers;
}

async function getArbitrumRpcCandidates() {
  const candidates = [];

  try {
    const dbProviders = await getActiveRPCProvidersForChain(ARBITRUM_CHAIN_ID);
    dbProviders.forEach((provider, index) => {
      candidates.push({
        name: `db:${provider.name || `provider-${index + 1}`}`,
        url: provider.url,
        source: 'db',
      });
    });
  } catch (error) {
    console.warn(`[probe] Failed to load DB RPC providers: ${getErrorMessage(error)}`);
  }

  candidates.push(...getArbitrumEnvProviders());

  const seenUrls = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.url.toLowerCase();
    if (seenUrls.has(key)) {
      return false;
    }
    seenUrls.add(key);
    return true;
  });
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function findDeploymentBlock(provider, contractAddress) {
  let low = 0;
  let high = await provider.getBlockNumber();

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const code = await provider.getCode(contractAddress, mid);
    if (code && code !== '0x') {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return low;
}

function decodeV4PositionInfo(infoRaw) {
  const info = BigInt(infoRaw);
  const tickLowerUint = Number((info >> 8n) & 0xFFFFFFn);
  const tickUpperUint = Number((info >> 32n) & 0xFFFFFFn);
  return {
    tickLower: tickLowerUint >= (1 << 23) ? tickLowerUint - (1 << 24) : tickLowerUint,
    tickUpper: tickUpperUint >= (1 << 23) ? tickUpperUint - (1 << 24) : tickUpperUint,
  };
}

function isArbitrumWbtcUsdcPosition(entry) {
  const currency0 = entry.poolKey.currency0.toLowerCase();
  const currency1 = entry.poolKey.currency1.toLowerCase();
  const expected0 = OFFICIAL_ARBITRUM_V4.currency0.toLowerCase();
  const expected1 = OFFICIAL_ARBITRUM_V4.currency1.toLowerCase();

  return (
    (currency0 === expected0 && currency1 === expected1) ||
    (currency0 === expected1 && currency1 === expected0)
  );
}

async function runCurrentBuiltInAdapter(ownerAddress, tokenId) {
  console.log('\n=== Current Built-in Adapter Control ===');
  const adapter = new UniswapV4WbtcUsdcRewardsAdapter();
  const positions = await adapter.discover(ownerAddress);
  const matching = positions.filter((position) => position.metadata && position.metadata.tokenId === tokenId);

  console.log(`Built-in adapter discovered ${positions.length} position(s) for ${ownerAddress}`);
  if (matching.length > 0) {
    console.log(`Built-in adapter DID find token ${tokenId}`);
    try {
      const value = await adapter.readCurrentValue(matching[0]);
      console.log(`Built-in adapter readCurrentValue: ${value}`);
    } catch (error) {
      console.log(`Built-in adapter readCurrentValue FAILED: ${getErrorMessage(error)}`);
    }
  } else {
    console.log(`Built-in adapter did NOT find token ${tokenId}`);
  }
}

async function probeProvider(candidate, tokenId) {
  console.log(`\n=== ${candidate.name} ===`);
  console.log(`RPC: ${redactUrl(candidate.url)}`);

  const provider = new ethers.JsonRpcProvider(candidate.url, ARBITRUM_CHAIN_ID);
  const positionManager = new ethers.Contract(
    OFFICIAL_ARBITRUM_V4.positionManager,
    getAbi('UniswapV4PositionManager'),
    provider
  );

  const network = await provider.getNetwork();
  console.log(`Network: ${network.name} (${network.chainId.toString()})`);

  const latestBlock = await provider.getBlockNumber();
  console.log(`Latest block: ${latestBlock}`);

  const deployBlock = await findDeploymentBlock(provider, OFFICIAL_ARBITRUM_V4.positionManager);
  console.log(`Detected PositionManager deployment block: ${deployBlock}`);

  const owner = await positionManager.ownerOf(tokenId);
  console.log(`ownerOf(${tokenId}): ${owner}`);

  const [poolKey, positionInfoRaw] = await positionManager.getPoolAndPositionInfo(tokenId);
  const ticks = decodeV4PositionInfo(positionInfoRaw);
  console.log('Pool key:', {
    currency0: poolKey.currency0,
    currency1: poolKey.currency1,
    fee: poolKey.fee.toString(),
    tickSpacing: poolKey.tickSpacing.toString(),
    hooks: poolKey.hooks,
    tickLower: ticks.tickLower,
    tickUpper: ticks.tickUpper,
  });

  clearWalletUniswapV4InventoryCache();
  const inventory = await getWalletUniswapV4Inventory(
    owner,
    OFFICIAL_ARBITRUM_V4.positionManager,
    deployBlock,
    provider
  );
  const matchingInventory = inventory.filter(isArbitrumWbtcUsdcPosition);
  const targetEntry = matchingInventory.find((entry) => entry.tokenId === tokenId);

  console.log(`Inventory size for owner: ${inventory.length}`);
  console.log(`WBTC/USDC entries after adapter-style filter: ${matchingInventory.length}`);
  if (targetEntry) {
    console.log(`Inventory DID find token ${tokenId}`);
  } else {
    console.log(`Inventory did NOT find token ${tokenId}`);
  }

  return {
    owner,
    deployBlock,
    inventoryFound: Boolean(targetEntry),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const parsedUrl = parsePositionUrl(options.url);
  const tokenId = options.tokenId || parsedUrl.tokenId;

  if (parsedUrl.chain !== 'arbitrum') {
    throw new Error(`This probe currently targets Arbitrum v4 positions only, received chain=${parsedUrl.chain}`);
  }

  const currentConfig = getProtocolConfig()[options.protocolKey];
  console.log('=== Target ===');
  console.log(`URL: ${options.url}`);
  console.log(`Token ID: ${tokenId}`);
  console.log(`Protocol key: ${options.protocolKey}`);

  console.log('\n=== Current Repo Config ===');
  console.log({
    positionManager: currentConfig?.positionManager,
    stateView: currentConfig?.stateView,
    currency0: currentConfig?.currency0,
    currency1: currentConfig?.currency1,
    deployBlock: currentConfig?.deployBlock,
  });

  console.log('\n=== Arbitrum Probe Config ===');
  console.log(OFFICIAL_ARBITRUM_V4);

  const candidates = await getArbitrumRpcCandidates();
  if (candidates.length === 0) {
    throw new Error('No Arbitrum RPC candidates found in DB or environment');
  }

  console.log(`\n=== RPC Candidates (${candidates.length}) ===`);
  candidates.forEach((candidate, index) => {
    console.log(`${index + 1}. ${candidate.name} -> ${redactUrl(candidate.url)}`);
  });

  let ownerAddress = null;
  const results = [];

  for (const candidate of candidates) {
    try {
      const result = await probeProvider(candidate, tokenId);
      if (!ownerAddress) {
        ownerAddress = result.owner;
      }
      results.push({ candidate: candidate.name, ok: true, ...result });
    } catch (error) {
      console.error(`[probe] ${candidate.name} failed: ${getErrorMessage(error)}`);
      results.push({ candidate: candidate.name, ok: false, error: getErrorMessage(error) });
    }
  }

  if (ownerAddress) {
    await runCurrentBuiltInAdapter(ownerAddress, tokenId);
  }

  console.log('\n=== Summary ===');
  results.forEach((result) => {
    if (!result.ok) {
      console.log(`${result.candidate}: FAILED (${result.error})`);
      return;
    }

    console.log(
      `${result.candidate}: owner=${result.owner}, deployBlock=${result.deployBlock}, inventoryFound=${result.inventoryFound}`
    );
  });

  await closePool().catch(() => {});
}

main().catch(async (error) => {
  console.error('[probe] fatal:', getErrorMessage(error));
  await closePool().catch(() => {});
  process.exit(1);
});
