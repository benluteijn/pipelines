// Copyright 2019-2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import fetch from 'node-fetch';
import { AWSConfigs, HttpConfigs, MinioConfigs } from '../configs';
import { Client as MinioClient } from 'minio';
import { PreviewStream } from '../utils';
import { createMinioClient, getObjectStream } from '../minio-helper';
import { Handler, Request, Response } from 'express';
import { Storage } from '@google-cloud/storage';

/**
 * ArtifactsQueryStrings describes the expected query strings key value pairs
 * in the artifact request object.
 */
interface ArtifactsQueryStrings {
  /** artifact source. */
  source: 'minio' | 's3' | 'gcs' | 'http' | 'https';
  /** bucket name. */
  bucket: string;
  /** artifact key/path that is uri encoded.  */
  key: string;
  /** return only the first x characters or bytes. */
  peek?: number;
}

/**
 * Returns an artifact handler which retrieve an artifact from the corresponding
 * backend (i.e. gcs, minio, s3, http/https).
 * @param artifactsConfigs configs to retrieve the artifacts from the various backend.
 */
export function getArtifactsHandler(artifactsConfigs: {
  aws: AWSConfigs;
  http: HttpConfigs;
  minio: MinioConfigs;
}): Handler {
  const { aws, http, minio } = artifactsConfigs;
  return async (req, res) => {
    const { source, bucket, key: encodedKey, peek = 0 } = req.query as Partial<
      ArtifactsQueryStrings
    >;
    if (!source) {
      res.status(500).send('Storage source is missing from artifact request');
      return;
    }
    if (!bucket) {
      res.status(500).send('Storage bucket is missing from artifact request');
      return;
    }
    if (!encodedKey) {
      res.status(500).send('Storage key is missing from artifact request');
      return;
    }
    const key = decodeURIComponent(encodedKey);
    console.log(`Getting storage artifact at: ${source}: ${bucket}/${key}`);
    switch (source) {
      case 'gcs':
        getGCSArtifactHandler({ bucket, key }, peek)(req, res);
        break;

      case 'minio':
        getMinioArtifactHandler(
          {
            bucket,
            client: new MinioClient(minio),
            key,
          },
          peek,
        )(req, res);
        break;

      case 's3':
        getMinioArtifactHandler(
          {
            bucket,
            client: await createMinioClient(aws),
            key,
          },
          peek,
        )(req, res);
        break;

      case 'http':
      case 'https':
        getHttpArtifactsHandler(
          getHttpUrl(source, http.baseUrl || '', bucket, key),
          http.auth,
          peek,
        )(req, res);
        break;

      default:
        res.status(500).send('Unknown storage source: ' + source);
        return;
    }
  };
}

/**
 * Returns the http/https url to retrieve a kfp artifact (of the form: `${source}://${baseUrl}${bucket}/${key}`)
 * @param source "http" or "https".
 * @param baseUrl string to prefix the url.
 * @param bucket name of the bucket.
 * @param key path to the artifact.
 */
function getHttpUrl(source: 'http' | 'https', baseUrl: string, bucket: string, key: string) {
  // trim `/` from both ends of the base URL, then append with a single `/` to the end (empty string remains empty)
  baseUrl = baseUrl.replace(/^\/*(.+?)\/*$/, '$1/');
  return `${source}://${baseUrl}${bucket}/${key}`;
}

function getHttpArtifactsHandler(
  url: string,
  auth: {
    key: string;
    defaultValue: string;
  } = { key: '', defaultValue: '' },
  peek: number = 0,
) {
  return async (req: Request, res: Response) => {
    const headers = {};

    // add authorization header to fetch request if key is non-empty
    if (auth.key.length > 0) {
      // inject original request's value if exists, otherwise default to provided default value
      headers[auth.key] =
        req.headers[auth.key] || req.headers[auth.key.toLowerCase()] || auth.defaultValue;
    }
    const response = await fetch(url, { headers });
    response.body
      .on('error', err => res.status(500).send(`Unable to retrieve artifact at ${url}: ${err}`))
      .pipe(new PreviewStream({ peek }))
      .pipe(res);
  };
}

function getMinioArtifactHandler(
  options: { bucket: string; key: string; client: MinioClient },
  peek: number = 0,
) {
  return async (_: Request, res: Response) => {
    try {
      const stream = await getObjectStream(options);
      stream
        .on('error', err =>
          res
            .status(500)
            .send(
              `Failed to get object in bucket ${options.bucket} at path ${options.key}: ${err}`,
            ),
        )
        .pipe(new PreviewStream({ peek }))
        .pipe(res);
    } catch (err) {
      res
        .status(500)
        .send(`Failed to get object in bucket ${options.bucket} at path ${options.key}: ${err}`);
    }
  };
}

function getGCSArtifactHandler(options: { key: string; bucket: string }, peek: number = 0) {
  const { key, bucket } = options;
  return async (_: Request, res: Response) => {
    try {
      // Read all files that match the key pattern, which can include wildcards '*'.
      // The way this works is we list all paths whose prefix is the substring
      // of the pattern until the first wildcard, then we create a regular
      // expression out of the pattern, escaping all non-wildcard characters,
      // and we use it to match all enumerated paths.
      const storage = new Storage();
      const prefix = key.indexOf('*') > -1 ? key.substr(0, key.indexOf('*')) : key;
      const files = await storage.bucket(bucket).getFiles({ prefix });
      const matchingFiles = files[0].filter(f => {
        // Escape regex characters
        const escapeRegexChars = (s: string) => s.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
        // Build a RegExp object that only recognizes asterisks ('*'), and
        // escapes everything else.
        const regex = new RegExp(
          '^' +
            key
              .split(/\*+/)
              .map(escapeRegexChars)
              .join('.*') +
            '$',
        );
        return regex.test(f.name);
      });

      if (!matchingFiles.length) {
        console.log('No matching files found.');
        res.send();
        return;
      }
      console.log(
        `Found ${matchingFiles.length} matching files: `,
        matchingFiles.map(file => file.name).join(','),
      );
      let contents = '';
      // TODO: support peek for concatenated matching files
      if (peek) {
        matchingFiles[0]
          .createReadStream()
          .pipe(new PreviewStream({ peek }))
          .pipe(res);
        return;
      }

      // if not peeking, iterate and append all the files
      matchingFiles.forEach((f, i) => {
        const buffer: Buffer[] = [];
        f.createReadStream()
          .on('data', data => buffer.push(Buffer.from(data)))
          .on('end', () => {
            contents +=
              Buffer.concat(buffer)
                .toString()
                .trim() + '\n';
            if (i === matchingFiles.length - 1) {
              res.send(contents);
            }
          })
          .on('error', () => res.status(500).send('Failed to read file: ' + f.name));
      });
    } catch (err) {
      res.status(500).send('Failed to download GCS file(s). Error: ' + err);
    }
  };
}
