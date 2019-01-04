const coordinates = require('../server/coordinates');
const fs = require('fs');
const byline = require('byline');
const path = require('path');
const pngjs = require('pngjs');
const request = require('request');
const unzip = require('unzip');

const dgmPath = path.join(__dirname, '../client/data/dgm/');

/**
 * Die Zeilen in einer xyz-Datei sehen so aus:
 * 644001.00 5650999.00 190.24
 * Dabei sind zuerst die eastings in der ersten Spalte aufsteigend sortiert.
 * Danach die northings in der zweiten Spalte ABSTEIGEND.
 * Die letzte Spalte stellt den Höhenert dar. Also:
 * 644000.00 5650999.00 190.24
 * 644001.00 5650999.00 190.24
 * ...
 * 644999.00 5650999.00 190.24
 * 644000.00 5650998.00 190.24
 * 644001.00 5650998.00 190.24
 * ...
 * 644999.00 5650001.00 190.24
 * 644000.00 5650000.00 190.24
 * 644001.00 5650000.00 190.24
 * ...
 * 644999.00 5650000.00 190.24
 * Jede Datei hat also stets 1.000 * 1.000 = 1.000.000 Einträge
 */

async function createImage(width, height, data, targetFile) {
    return new Promise(function(resolve, reject) {
        const min = data.reduce((min, val) => val < min ? val : min, data[0]);
        const png = new pngjs.PNG({ width: width, height: height, colorType: 2 });
        for (let i = 0, pixelIndex = 0; i < data.length; i++, pixelIndex += 4) {
            const height = data[i] - min;
            const r = height & 0xff, g = (height >> 8) & 0xff, b = (height >> 16) & 0xff, a = 0xff;
            png.data[pixelIndex] = r;
            png.data[pixelIndex + 1] = g;
            png.data[pixelIndex + 2] = b
            png.data[pixelIndex + 3] = a;
        }
        png.pack().pipe(fs.createWriteStream(targetFile)).on('close', function () {
            resolve(min);
        });
    });
}

async function createHeightMaps(coordinates) {
    console.log('Generating heightmaps ...');
    return new Promise(function (resolve, reject) {
        let index = 0, index2 = 0, chunkY = 0, chunkX = 0;
        const chunks = [];
        for (let i = 0; i < 10; i++) {
            const chunk = [];
            chunks.push(chunk);
            for (let j = 0; j < 10; j++) chunk.push([]);
        }
        const fileStream = fs.createReadStream(coordinates.xyzFile);
        fileStream.on('close', async function () {
            const heightMapData = [];
            for (let i = 0; i < 10; i++) {
                for (let j = 0; j < 10; j++) {
                    const targetFile = path.join(coordinates.directory, i + '_' + j + '.png')
                    const min = await createImage(100, 100, chunks[i][j], targetFile);
                    heightMapData.push(min);
                }
            }
            await createImage(10, 10, heightMapData, coordinates.overviewHeightmap);
            resolve();
        });
        const lineStream = byline.createStream(fileStream);
        lineStream.on('data', function (line) {
            if (index > 99) {
                chunkX++;
                if (chunkX > 9) {
                    index2++;
                    if (index2 > 99) {
                        chunkY++;
                        index2 = 0;
                    }
                    chunkX = 0;
                }
                index = 0;
            }
            const lineString = line.toString();
            if (!lineString) return;
            const lineParts = lineString.split(' ');
            if (lineParts.length < 3) return;
            const height = parseInt(lineParts[2].replace('.', '')); // Height in centimeters
            chunks[chunkX][chunkY].push(height);
            index++;
        });
    });
}

function downloadFromUrl(url, targetFile) {
    return new Promise(function (resolve, reject) {
        const fileStream = fs.createWriteStream(targetFile);
        fileStream.on('close', function () {
            resolve();
        });
        request(url).pipe(fileStream);
    });
}

async function downloadZipFile(bbox, targetFile) {
    console.log('Fetching overview ...');
    const overviewUrl = 'https://geoportal.geoportal-th.de/gaialight-th/_apps/dladownload/_ajax/overview.php?bbox%5B%5D=' + bbox[0] + '&bbox%5B%5D=' + bbox[1] + '&bbox%5B%5D=' + bbox[2] + '&bbox%5B%5D=' + bbox[3] + '&crs=EPSG%3A25832&type%5B%5D=dhm1';
    const overview = await getJson(overviewUrl);
    var features = overview.result.features;
    for (let i = 0; i < features.length; i++) {
        const feature = features[i];
        const detailsUrl = 'https://geoportal.geoportal-th.de/gaialight-th/_apps/dladownload/_ajax/details.php?type=dhm1&id=' + feature.properties.gid;
        const details = await getJson(detailsUrl);
        const dgmUrl = 'https://geoportal.geoportal-th.de' + details.object.file1;
        console.log('Downloading ' + dgmUrl + ' ...');
        await downloadFromUrl(dgmUrl, targetFile);
    }
}

function extractXYZFile(zipFilePath, targetFile) {
    console.log('Extracting ' + zipFilePath + ' ...');
    return new Promise(function (resolve, reject) {
        fs.createReadStream(zipFilePath).pipe(unzip.Parse()).on('entry', function (entry) {
            const fileName = entry.path;
            if (!fileName.endsWith('.xyz')) return entry.autodrain;
            const fileStream = fs.createWriteStream(targetFile);
            fileStream.on('close', function () {
                resolve();
            });
            entry.pipe(fileStream);
        });
    });
}

function getCoordinates(latitude, longitude, basePath) {
    const utmCoordinates = coordinates.fromLatLon(latitude, longitude);
    const easting = Math.floor(utmCoordinates.easting);
    const northing = Math.floor(utmCoordinates.northing);
    const directory = path.join(basePath, Math.floor(easting / 1000).toString(), Math.floor(northing / 1000).toString());
    return {
        easting: utmCoordinates.easting,
        northing: utmCoordinates.northing,
        bbox: [easting, northing, easting + 1, northing + 1],
        directory: directory,
        zipFile: path.join(directory, 'dgm.zip'),
        xyzFile: path.join(directory, 'dgm.xyz'),
        overviewHeightmap: path.join(directory, 'heightmap.png'), // Overview heightmap for 1 square kilometer with resolution of 10 meters
    }
}

function getJson(url) {
    return new Promise(function (resolve, reject) {
        request(url, function (error, response, body) {
            const json = JSON.parse(body);
            resolve(json);
        });
    });
}

function prepareDirectory(directory) {
    if (!fs.existsSync(directory)) {
        prepareDirectory(path.dirname(directory));
        fs.mkdirSync(directory);
    }
}

/**
 * Lädt Höhendaten vom Geoportal und generiert binäre
 * Profildateien, die im Client als Heightmaps interpretiert werden können.
 * 
 * Das das Geoportal Thüringen eben nur Daten von Thüringen bereit stellt, verwende ich als Datenquelle
 * http://data.opendataportal.at/dataset/dtm-germany bzw. https://drive.google.com/drive/folders/0BxphPoRgwhnoWkRoTFhMbTM3RDA,
 * wo die Höhendaten von ganz Europa zu finden sind. Dort ist die Auflösung aber nur 20m-30m.
 */

(async function () {

    // Koordinaten festlegen, wie sie aus GPS Receivers kämen
    const latitude = 50.9904901;
    const longitude = 11.0528969;

    // Koordinaten ins UTM-Format umwandeln
    const coordinates = getCoordinates(latitude, longitude, dgmPath);

    // Datenpfad vorbereiten
    prepareDirectory(coordinates.directory);

    // Prüfen, ob DGM-ZIP-Datei bereits vorhanden ist und ggf herunterladen
    if (!fs.existsSync(coordinates.zipFile)) {
        await downloadZipFile(coordinates.bbox, coordinates.zipFile);
    }

    // Prüfen, ob XYZ-Datei vorhanden ist und ggf. extrahieren
    if (!fs.existsSync(coordinates.xyzFile)) {
        await extractXYZFile(coordinates.zipFile, coordinates.xyzFile);
    }

    // Prüfen, ob Übersichts-Heightmap erzeugt wurde und ggf. alle Heightmaps erstellen
    if (!fs.existsSync(coordinates.overviewHeightmap)) {
        await createHeightMaps(coordinates);
    }

})();