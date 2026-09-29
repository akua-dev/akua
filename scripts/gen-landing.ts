#!/usr/bin/env bun
//! Render `site/index.html` — the landing page. Hand-authored content,
//! threaded through the shared page shell so the topnav + style match
//! the rest of the site.
//!
//! Design: tight vertical-centered single column. The brand mark lives
//! in the (scroll-revealed) topnav so the landing's first impression
//! is "akua + install command" with nothing pushing the prompt down.

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageShell } from './site/layout.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const body = `
<header style="margin-bottom: 32px;">
  <h1 style="margin: 0 0 6px; font: 600 44px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.02em;">akua</h1>
  <p style="margin: 0; font-size: 17px; color: var(--muted);">
    One binary for cloud-native packaging. Render, verify, sign, publish. KCL-typed. Helm and Kustomize embedded as WebAssembly. Sandboxed by default.
  </p>
</header>

<h2>Install (macOS / Linux)</h2>
<pre><code><span style="color: var(--accent); user-select: none;">$</span> curl -fsSL https://cli.akua.dev/install | sh</code></pre>

<h2>Homebrew</h2>
<pre><code><span style="color: var(--accent); user-select: none;">$</span> brew install akua-dev/tap/akuapkg</code></pre>

<h2>Install (Windows)</h2>
<pre><code><span style="color: var(--accent); user-select: none;">&gt;</span> irm https://cli.akua.dev/install.ps1 | iex</code></pre>

<h2>From source</h2>
<pre><code><span style="color: var(--accent); user-select: none;">$</span> cargo install --git https://github.com/akua-dev/akuapkg akuapkg-cli</code></pre>

<h2>SDK</h2>
<p>npm publishing is discontinued; see the <a href="/concepts/sdk">SDK docs</a> for building <code>@akua-dev/sdk</code> from source.</p>

<h2>Docs</h2>
<ul style="list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 16px; color: var(--muted); font-size: 14px;">
  <li><a href="/start/">Get started</a></li>
  <li><a href="/cli/">CLI</a></li>
  <li><a href="/concepts/">Concepts</a></li>
  <li><a href="/examples/">Examples</a></li>
  <li><a href="/errors/">Errors</a></li>
  <li><a href="https://github.com/akua-dev/akuapkg">GitHub</a></li>
  <li><a href="https://github.com/akua-dev/akuapkg/releases">Releases</a></li>
</ul>

<p style="color: var(--muted); font-size: 13px; margin-top: 28px;">
  Pre-alpha. Twenty-seven verbs wired behind one command surface.
</p>
`.trim();

const html = pageShell({
	title: 'akua — one binary for cloud-native packaging',
	description:
		'One binary: render, verify, sign, publish. KCL-typed. Helm and Kustomize embedded as WebAssembly. Sandboxed by default.',
	body,
	currentSection: null,
	sidebar: null,
	canonicalUrl: 'https://akua.dev/',
	bodyClass: 'landing',
});

writeFileSync(join(root, 'site/index.html'), html);
console.log('wrote site/index.html');
