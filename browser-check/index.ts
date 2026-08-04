import { executeSquidFunding, planSquidFunding } from "squid-evm-funding"
import { createWalletClient, custom } from "viem"
import { arbitrum } from "viem/chains"

type BrowserProvider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

export const squidBrowserApi = { executeSquidFunding, planSquidFunding }

export async function connectSquidBrowserWallet(provider: BrowserProvider) {
  const transport = custom(provider)
  const connection = createWalletClient({ chain: arbitrum, transport })
  const [address] = await connection.requestAddresses()
  if (address == null) throw new Error("The browser wallet returned no account")

  return {
    address,
    walletClient: createWalletClient({
      account: address,
      chain: arbitrum,
      transport,
    }),
  }
}
