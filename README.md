# papi-polkadot-populate

This tool aims to easily create a main account, fund it, derive several child accounts from it, fund them, and have all of them nominate. The stakes of these accounts are somewhat variable; when we take the election snapshot, some accounts are included while others are not.

The project is inspired by https://github.com/shawntabrizi/polkadot-populate.

## Installation

To install dependencies:

```bash
bun install
```

## Run

To run:

```bash
bun run index.ts
```

## Choose your network

The project targets initially `paseo` testnet.
PAPI dependencies for Paseo have been added via

```bash
bun papi add -n paseo paseo
```

If you want to target another network (e.g. `Westend`) simply do something like

```bash
bun papi add -n westend wnd
```

and replace the following lines in `index.ts`:

```ts
import { MultiAddress, paseo } from "@polkadot-api/descriptors";
import { chainSpec } from "polkadot-api/chains/paseo";
...
// get the safely typed API
const api = client.getTypedApi(paseo);
```

NOTE: this project was created using `bun init` in bun v1.2.16. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
