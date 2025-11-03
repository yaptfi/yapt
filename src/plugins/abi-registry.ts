const abiMap: Map<string, any[]> = new Map();

export function registerAbi(abiKey: string, abi: any[]): void {
  abiMap.set(abiKey, abi);
}

export function getPluginAbi(abiKey: string): any[] | undefined {
  return abiMap.get(abiKey);
}

export function clearPluginAbis(): void {
  abiMap.clear();
}

