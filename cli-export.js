#!/usr/bin/env node

const defaults = require('./src/defaults');
const figma = require('./src/figma-client');
const fs = require('fs');
const path = require('path');
const ora = require('ora');
const chalk = require('chalk');
const mkdirp = require('mkdirp');
const axios = require('axios');
const prompts = require('prompts');
const argv = require('minimist')(process.argv.slice(2));

let config = {};
let figmaClient;
const spinner = ora();

function updateGitIgnore() {
  const ignorePath = '.gitignore';
  const configPath = argv.config || defaults.configFileName;
  const ignoreCompletePath = path.resolve(ignorePath);
  if (fs.existsSync(configPath)) {
    const ignoreContent = `\n#figma-export-icons\n${configPath}`;
    const ignore = fs.existsSync(ignoreCompletePath)
      ? fs.readFileSync(ignoreCompletePath, 'utf-8')
      : '';
    if (!ignore.includes(ignoreContent)) {
      fs.writeFileSync(ignoreCompletePath, ignore + ignoreContent);
      console.log(`Updated ${ignorePath} : ${ignoreContent}`);
    }
  }
}

// Leer el archivo de configuración `icons-config.json`
function getConfig() {
  return new Promise((resolve, reject) => {
    const configFilePath = path.resolve('icons-config.json');
    if (fs.existsSync(configFilePath)) {
      config = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
      resolve();
    } else {
      console.error(
        chalk.red.bold(
          'Config file `pages-config.json` not found! Please create the file.'
        )
      );
      reject('Config file not found');
    }
  });
}

function removeFromName(name) {
  // Usar una expresión regular para extraer solo el nombre final después de `=`
  const cleanName = name.includes('=') ? name.split('=').pop() : name;
  // Reemplazar espacios con guiones y convertir todo a minúsculas
  return cleanName.trim().replace(/\s+/g, '-').toLowerCase();
}

function sanitizePath(name) {
  return name.replace(/[<>:"\/\\|?*\u0000-\u001F]/g, '-'); // Reemplaza caracteres no válidos con '-'
}

async function createOutputDirectory(pageName) {
  const cleanPageName = sanitizePath(pageName);
  const directory = path.resolve(config.iconsPath, cleanPageName);
  if (!fs.existsSync(directory)) {
    mkdirp.sync(directory);
    console.log(`Created directory ${directory}`);
  }
  return directory;
}

// Obtener las páginas desde el archivo de configuración basadas en `library`
async function getAllPages() {
  try {
    if (!config.library) {
      console.error(
        chalk.red.bold(
          'No library specified in `pages-config.json`. Use "library": "icons" or "spots".'
        )
      );
      process.exit(1);
    }

    let pages = [];
    if (config.library === 'icons') {
      pages = config.pagesIcons;
    } else if (config.library === 'spots') {
      pages = config.pagesSpots;
    } else {
      console.error(
        chalk.red.bold(
          'Invalid library value in `pages-config.json`. Use "icons" or "spots".'
        )
      );
      process.exit(1);
    }

    if (!pages || !Array.isArray(pages) || pages.length === 0) {
      console.error(
        chalk.red.bold(
          `No pages found for the specified library: ${config.library}.`
        )
      );
      process.exit(1);
    }

    console.log(
      `Using pages for library "${config.library}": ${pages.join(', ')}`
    );
    return pages;
  } catch (err) {
    console.error(`Error reading pages from config: ${err.message}`);
    process.exit(1);
  }
}

function deleteIcons() {
  return new Promise((resolve, reject) => {
    const directory = path.resolve(config.iconsPath);
    spinner.start('Deleting directory contents');

    fs.promises
      .rm(directory, { recursive: true, force: true })
      .then(() => {
        spinner.succeed('Directory contents deleted successfully.');
        resolve();
      })
      .catch((err) => {
        spinner.fail('Failed to delete directory contents.');
        console.error(`Error: ${err.message}`);
        reject(err);
      });
  });
}
async function getIconsFromPage(pageName) {
  spinner.start(`Fetching icons from page: ${pageName}`);
  try {
    const res = await figmaClient.get(`/files/${config.fileId}`);
    const page = res.data.document.children.find((c) => c.name === pageName);
    if (!page) {
      console.log(chalk.red.bold(`Cannot find page: ${pageName}`));
      return [];
    }

    let iconsArray = [];
    function traverseNodes(node, parentCategory = '') {
      if (node.children) {
        node.children.forEach((child) => {
          const currentCategory = parentCategory || node.name;
          if (child.type === 'COMPONENT' || child.type === 'INSTANCE') {
            iconsArray.push({
              id: child.id,
              name: child.name,
              path: node.name,
              category: currentCategory,
              page: pageName,
            });
          }
          traverseNodes(child, currentCategory);
        });
      }
    }
    traverseNodes(page);
    spinner.succeed(`Found ${iconsArray.length} icons in page: ${pageName}`);
    return iconsArray;
  } catch (err) {
    spinner.fail(`Failed to fetch icons from page: ${pageName}`);
    console.error(`Error: ${err.message}`);
    return [];
  }
}

// async function getImages(icons) {
//   spinner.start('Fetching icon URLs...');
//   try {
//     const iconIds = icons.map((icon) => icon.id).join(',');
//     const res = await figmaClient.get(
//       `/images/${config.fileId}?ids=${iconIds}&format=svg`
//     );
//     const images = res.data.images;
//     icons.forEach((icon) => {
//       icon.image = images[icon.id];
//     });
//     spinner.succeed('Fetched icon URLs successfully.');
//     return icons;
//   } catch (err) {
//     spinner.fail('Failed to fetch icon URLs.');
//     console.error(`Error: ${err.message}`);
//     process.exit(1);
//   }
// }

async function getImages(icons) {
  spinner.start('Fetching icon URLs...');
  try {
    // Dividir los iconos en lotes de 50 (ajústalo si es necesario)
    const chunkSize = 100;
    let iconChunks = [];
    for (let i = 0; i < icons.length; i += chunkSize) {
      iconChunks.push(icons.slice(i, i + chunkSize));
    }

    // Almacenar todas las promesas para hacer solicitudes en paralelo
    const iconUrlPromises = iconChunks.map(async (iconChunk) => {
      const iconIds = iconChunk.map((icon) => icon.id).join(',');
      const res = await figmaClient.get(
        `/images/${config.fileId}?ids=${iconIds}&format=svg`
      );
      const images = res.data.images;

      // Asignar las URLs a los íconos correspondientes
      iconChunk.forEach((icon) => {
        icon.image = images[icon.id];
      });

      return iconChunk;
    });

    // Esperar a que todas las solicitudes se completen
    const iconsWithUrls = (await Promise.all(iconUrlPromises)).flat();

    spinner.succeed('Fetched icon URLs successfully.');
    return iconsWithUrls;
  } catch (err) {
    spinner.fail('Failed to fetch icon URLs.');
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function downloadIcon(icon, retries = 3) {
  try {
    const cleanName = removeFromName(icon.name);
    const directory = path.resolve(config.iconsPath, icon.page);
    const imagePath = path.resolve(directory, `${cleanName}.svg`);
    const writer = fs.createWriteStream(imagePath);

    console.log(`Downloading ${icon.name} from ${icon.image} to ${directory}`);

    const imageRes = await axios.get(icon.image, { responseType: 'stream' });
    imageRes.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () =>
        resolve({ name: `${cleanName}.svg`, size: fs.statSync(imagePath).size })
      );
      writer.on('error', (err) => reject(err));
    });
  } catch (err) {
    if (retries > 0) {
      console.warn(
        `Retrying download for ${icon.name}. Retries left: ${retries - 1}`
      );
      return downloadIcon(icon, retries - 1);
    } else {
      console.error(`Failed to download icon ${icon.name}: ${err.message}`);
      // Registrar en el log de errores
      fs.appendFileSync(
        'download-errors.log',
        `${new Date().toISOString()} - ${icon.name}: ${err.message}\n`
      );
    }
  }
}
async function exportIcons() {
  const pages = await getAllPages();

  for (const page of pages) {
    await createOutputDirectory(page);
    const icons = await getIconsFromPage(page);
    const iconsWithUrls = await getImages(icons);

    console.log(
      `Starting download for ${iconsWithUrls.length} icons in page: ${page}`
    );
    await Promise.all(iconsWithUrls.map((icon) => downloadIcon(icon)));
  }

  console.log('All icons from all pages downloaded successfully!');
}

function run() {
  updateGitIgnore();
  getConfig().then(() => {
    figmaClient = figma(config.figmaPersonalToken);
    exportIcons();
  });
}

run();
