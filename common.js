const os = require('os')
const path = require('path')
const fs = require('fs')
const util = require('util')
const stream = require('stream')
const crypto = require('crypto')
const core = require('@actions/core')
const { performance } = require('perf_hooks')

export const windows = (os.platform() === 'win32')
// Extract to SSD on Windows, see https://github.com/ruby/setup-ruby/pull/14
export const drive = (windows ? (process.env['GITHUB_WORKSPACE'] || 'C')[0] : undefined)

export function partition(string, separator) {
  const i = string.indexOf(separator)
  if (i === -1) {
    throw new Error(`No separator ${separator} in string ${string}`)
  }
  return [string.slice(0, i), string.slice(i + separator.length, string.length)]
}

let inGroup = false

export async function measure(name, block) {
  const body = async () => {
    const start = performance.now()
    try {
      return await block()
    } finally {
      const end = performance.now()
      const duration = (end - start) / 1000.0
      console.log(`Took ${duration.toFixed(2).padStart(6)} seconds`)
    }
  }

  if (inGroup) {
    // Nested groups are not yet supported on GitHub Actions
    console.log(`> ${name}`)
    return await body()
  } else {
    inGroup = true
    try {
      return await core.group(name, body)
    } finally {
      inGroup = false
    }
  }
}

export function isHeadVersion(rubyVersion) {
  return ['head', 'debug',  'mingw', 'mswin', 'ucrt'].includes(rubyVersion)
}

export function isStableVersion(rubyVersion) {
  return /^\d+(\.\d+)*$/.test(rubyVersion)
}

export function hasBundlerDefaultGem(engine, rubyVersion) {
  return isBundler1Default(engine, rubyVersion) || isBundler2Default(engine, rubyVersion)
}

export function isBundler1Default(engine, rubyVersion) {
  if (engine === 'ruby') {
    return floatVersion(rubyVersion) >= 2.6 && floatVersion(rubyVersion) < 2.7
  } else if (engine.startsWith('truffleruby')) {
    return floatVersion(rubyVersion) < 21.0
  } else if (engine === 'jruby') {
    return false
  } else {
    return false
  }
}

export function isBundler2Default(engine, rubyVersion) {
  if (engine === 'ruby') {
    return floatVersion(rubyVersion) >= 2.7
  } else if (engine.startsWith('truffleruby')) {
    return floatVersion(rubyVersion) >= 21.0
  } else if (engine === 'jruby') {
    return floatVersion(rubyVersion) >= 9.3
  } else {
    return false
  }
}

export function isBundler2dot2Default(engine, rubyVersion) {
  if (engine === 'ruby') {
    return floatVersion(rubyVersion) >= 3.0
  } else if (engine.startsWith('truffleruby')) {
    return floatVersion(rubyVersion) >= 22.0
  } else if (engine === 'jruby') {
    return floatVersion(rubyVersion) >= 9.3
  } else {
    return false
  }
}

export function targetRubyVersion(engine, rubyVersion) {
  const version = floatVersion(rubyVersion)
  if (engine === 'ruby') {
    return version
  } else if (engine === 'jruby') {
    if (version === 9.1) {
      return 2.3
    } else if (version === 9.2) {
      return 2.5
    } else if (version === 9.3) {
      return 2.6
    }
  } else if (engine.startsWith('truffleruby')) {
    if (version < 21.0) {
      return 2.6
    } else if (version < 22.0) {
      return 2.7
    } else if (version < 23.0) {
      return 3.0
    }
  }

  return 9.9 // unknown, assume recent
}

export function floatVersion(rubyVersion) {
  const match = rubyVersion.match(/^\d+\.\d+/)
  if (match) {
    return parseFloat(match[0])
  } else if (isHeadVersion(rubyVersion)) {
    return 999.999
  } else {
    throw new Error(`Could not convert version ${rubyVersion} to a float`)
  }
}

export async function hashFile(file) {
  // See https://github.com/actions/runner/blob/master/src/Misc/expressionFunc/hashFiles/src/hashFiles.ts
  const hash = crypto.createHash('sha256')
  const pipeline = util.promisify(stream.pipeline)
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

function getImageOS() {
  const imageOS = process.env['ImageOS']
  if (!imageOS) {
    throw new Error('The environment variable ImageOS must be set')
  }
  return imageOS
}

export const supportedPlatforms = [
  'ubuntu-18.04',
  'ubuntu-20.04',
  'ubuntu-22.04',
  'macos-10.15',
  'macos-11',
  'macos-12',
  'macos-13',
  'windows-2019',
  'windows-2022',
]

export function getVirtualEnvironmentName() {
  const imageOS = getImageOS()

  let match = imageOS.match(/^ubuntu(\d+)/) // e.g. ubuntu18
  if (match) {
    return `ubuntu-${match[1]}.04`
  }

  match = imageOS.match(/^macos(\d{2})(\d+)?/) // e.g. macos1015, macos11
  if (match) {
    if (match[2]) {
      return `macos-${match[1]}.${match[2]}`
    } else {
      return `macos-${match[1]}`
    }
  }

  match = imageOS.match(/^win(\d+)/) // e.g. win19
  if (match) {
    return `windows-20${match[1]}`
  }

  throw new Error(`Unknown ImageOS ${imageOS}`)
}

export function shouldUseToolCache(engine, version) {
  return engine === 'ruby' && !isHeadVersion(version)
}

function getPlatformToolCache(platform) {
  // Hardcode paths rather than using $RUNNER_TOOL_CACHE because the prebuilt Rubies cannot be moved anyway
  if (platform.startsWith('ubuntu-')) {
    return '/opt/hostedtoolcache'
  } else if (platform.startsWith('macos-')) {
    return '/Users/runner/hostedtoolcache'
  } else if (platform.startsWith('windows-')) {
    return 'C:/hostedtoolcache/windows'
  } else {
    throw new Error('Unknown platform')
  }
}

export function getToolCacheRubyPrefix(platform, version) {
  const toolCache = getPlatformToolCache(platform)
  return path.join(toolCache, 'Ruby', version, 'x64')
}

export function createToolCacheCompleteFile(toolCacheRubyPrefix) {
  const completeFile = `${toolCacheRubyPrefix}.complete`
  fs.writeFileSync(completeFile, '')
}

// convert windows path like C:\Users\runneradmin to /c/Users/runneradmin
export function win2nix(path) {
  if (/^[A-Z]:/i.test(path)) {
    // path starts with drive
    path = `/${path[0].toLowerCase()}${partition(path, ':')[1]}`
  }
  return path.replace(/\\/g, '/').replace(/ /g, '\\ ')
}

// JRuby is installed after setupPath is called, so folder doesn't exist
function rubyIsUCRT(path) {
  return !!(fs.existsSync(path) &&
    fs.readdirSync(path, { withFileTypes: true }).find(dirent =>
      dirent.isFile() && dirent.name.match(/^x64-(ucrt|vcruntime\d{3})-ruby\d{3}\.dll$/)))
}

export function setupPath(newPathEntries) {
  let msys2Type = null
  const envPath = windows ? 'Path' : 'PATH'
  const originalPath = process.env[envPath].split(path.delimiter)
  let cleanPath = originalPath.filter(entry => !/\bruby\b/i.test(entry))

  core.startGroup(`Modifying ${envPath}`)

  // First remove the conflicting path entries
  if (cleanPath.length !== originalPath.length) {
    console.log(`Entries removed from ${envPath} to avoid conflicts with default Ruby:`)
    for (const entry of originalPath) {
      if (!cleanPath.includes(entry)) {
        console.log(`  ${entry}`)
      }
    }
    core.exportVariable(envPath, cleanPath.join(path.delimiter))
  }

  // Then add new path entries using core.addPath()
  let newPath
  if (windows) {
    // main Ruby dll determines whether mingw or ucrt build
    msys2Type = rubyIsUCRT(newPathEntries[0]) ? 'ucrt64' : 'mingw64'

    // add MSYS2 in path for all Rubies on Windows, as it provides a better bash shell and a native toolchain
    const msys2 = [`C:\\msys64\\${msys2Type}\\bin`, 'C:\\msys64\\usr\\bin']
    newPath = [...newPathEntries, ...msys2]
  } else {
    newPath = newPathEntries
  }
  console.log(`Entries added to ${envPath} to use selected Ruby:`)
  for (const entry of newPath) {
    console.log(`  ${entry}`)
  }
  core.endGroup()

  core.addPath(newPath.join(path.delimiter))
  return msys2Type
}
