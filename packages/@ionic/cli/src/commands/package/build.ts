import { CommandLineInputs, CommandLineOptions, MetadataGroup, combine, contains, validators } from '@ionic/cli-framework';
import { LOGGER_LEVELS } from '@ionic/cli-framework-output';
import { tmpfilepath } from '@ionic/utils-fs';
import { columnar } from '@ionic/utils-terminal';
import { sleep } from '@ionic/utils-process';
import * as chalk from 'chalk';
import * as Debug from 'debug';
import * as fs from 'fs';

import { CommandMetadata } from '../../definitions';
import { isSuperAgentError } from '../../guards';
import { input, strong, weak } from '../../lib/color';
import { Command } from '../../lib/command';
import { FatalException } from '../../lib/errors';
import { fileUtils } from '../../lib/utils/file';
import { createRequest, download } from '../../lib/utils/http';
import { IONIC_CLOUD_CLI_MIGRATION } from '../../lib/updates';

const debug = Debug('ionic:commands:package:build');
const PLATFORMS = ['android', 'ios'];

const ANDROID_BUILD_TYPES = ['debug', 'release'];
const IOS_BUILD_TYPES = ['development', 'ad-hoc', 'app-store', 'enterprise'];
const APP_STORE_COMPATIBLE_TYPES = ['release', 'app-store', 'enterprise'];
const BUILD_TYPES = ANDROID_BUILD_TYPES.concat(IOS_BUILD_TYPES);
const ANDROID_ARTIFACT_TYPES = ['aab', 'apk'];
const IOS_ARTIFACT_TYPES = ['ipa', 'dsym'];
const ARTIFACT_TYPES = ANDROID_ARTIFACT_TYPES.concat(IOS_ARTIFACT_TYPES);
const TARGET_PLATFORM = ['Android', 'iOS - Xcode 11 (Preferred)', 'iOS - Xcode 10'];

interface Artifact {
  name: string;
  url: string;
  artifact_type: string;
}

export interface PackageBuild {
  job_id: number;
  id: string;
  caller_id: number;
  platform: string;
  build_type: string;
  created: string;
  finished: string;
  state: string;
  commit: any;
  stack: any;
  profile_tag: string;
  automation_id: number;
  environment_id: number;
  native_config_id: number;
  automation_name: string;
  environment_name: string;
  native_config_name: string;
  distribution_credential_name: string;
  job: any;
  distribution_trace: string;
  artifacts: Artifact[];
}

interface DownloadUrl {
  url: string | null;
}

export class BuildCommand extends Command {
  async getMetadata(): Promise<CommandMetadata> {
    const dashUrl = this.env.config.getDashUrl();

    return {
      name: 'build',
      type: 'project',
      groups: [MetadataGroup.PAID, MetadataGroup.DEPRECATED],
      summary: 'Create a package build on Appflow',
      description: `
This command creates a package build on Appflow. While the build is running, it prints the remote build log to the terminal. If the build is successful, it downloads the created app package file in the current directory. Downloading build artifacts can be skipped by supplying the flag ${input('skip-download')}.

Apart from ${input('--commit')}, every option can be specified using the full name setup within the Dashboard[^dashboard].

The ${input('--signing-certificate')} option is mandatory for any iOS build but not for Android debug builds.

Customizing the build:
- The ${input('--environment')} and ${input('--native-config')} options can be used to customize the groups of values exposed to the build.
- Override the preferred platform with ${input('--build-stack')}. This is useful for building older iOS apps.

Deploying the build to an App Store:
- The ${input('--destination')} option can be used to deliver the app created by the build to the configured App Store. \
This can be used only together with build type ${input('release')} for Android and build types ${input('app-store')} or ${input('enterprise')} for iOS.

Downloading build artifacts:
- By default once the build is complete, all artifacts are downloaded for the selected platform. ${input('aab')} and ${input('apk')} for Android \
${input('ipa')} and ${input('dsym')} for iOS.
- The ${input('--artifact-type')} option can be used to limit artifact downloads to only of that type. For instance, with Android, you can specify ${input('aab')} \
if you do not wish to download ${input('apk')}.
`,
      footnotes: [
        {
          id: 'dashboard',
          url: dashUrl,
        },
      ],
      exampleCommands: [
        'android debug',
        'ios development --signing-certificate="iOS Signing Certificate Name"',
        'android debug --environment="My Custom Environment Name"',
        'android debug --native-config="My Custom Native Config Name"',
        'android debug --commit=2345cd3305a1cf94de34e93b73a932f25baac77c',
        'android debug --artifact-type=aab',
        'android debug --skip-download',
        'android debug --aab-name="my-app-prod.aab" --apk-name="my-app-prod.apk"',
        'ios development --signing-certificate="iOS Signing Certificate Name" --build-stack="iOS - Xcode 9"',
        'ios development --signing-certificate="iOS Signing Certificate Name" --ipa-name=my_custom_file_name.ipa',
        'ios app-store --signing-certificate="iOS Signing Certificate Name" --destination="Apple App Store Destination"',
      ],
      inputs: [
        {
          name: 'platform',
          summary: `The platform to package (${PLATFORMS.map(v => input(v)).join(', ')})`,
          validators: [validators.required, contains(PLATFORMS, {})],
        },
        {
          name: 'type',
          summary: `The build type (${BUILD_TYPES.map(v => input(v)).join(', ')})`,
          validators: [validators.required, contains(BUILD_TYPES, {})],
        },
      ],
      options: [
        {
          name: 'signing-certificate',
          summary: 'Signing certificate',
          type: String,
          spec: { value: 'name' },
        },
        {
          name: 'environment',
          summary: 'The group of environment variables exposed to your build',
          type: String,
          spec: { value: 'name' },
        },
        {
          name: 'native-config',
          summary: 'The group of native config variables exposed to your build',
          type: String,
          spec: { value: 'name' },
        },
        {
          name: 'destination',
          summary: 'The configuration to deploy the build artifact to the app store',
          type: String,
          spec: { value: 'name' },
        },
        {
          name: 'commit',
          summary: 'Commit (defaults to HEAD)',
          type: String,
          groups: [MetadataGroup.ADVANCED],
          spec: { value: 'sha1' },
        },
        {
          name: 'build-stack',
          summary: `Target platform (${TARGET_PLATFORM.map(v => input(`"${v}"`)).join(', ')})`,
          type: String,
          groups: [MetadataGroup.ADVANCED],
          spec: { value: 'name' },
        },
        {
          name: 'build-file-name',
          summary: 'The name for the downloaded build file',
          type: String,
          groups: [MetadataGroup.DEPRECATED],
          spec: { value: 'name' },
        },
        {
          name: 'ipa-name',
          summary: 'The name for the downloaded ipa file',
          type: String,
          groups: [MetadataGroup.ADVANCED],
          spec: { value: 'name' },
        },
        {
          name: 'dsym-name',
          summary: 'The name for the downloaded dsym file',
          type: String,
          groups: [MetadataGroup.ADVANCED],
          spec: { value: 'name' },
        },
        {
          name: 'apk-name',
          summary: 'The name for the downloaded apk file',
          type: String,
          groups: [MetadataGroup.ADVANCED],
          spec: { value: 'name' },
        },
        {
          name: 'aab-name',
          summary: 'The name for the downloaded aab file',
          type: String,
          groups: [MetadataGroup.ADVANCED],
          spec: { value: 'name' },
        },
        {
          name: 'artifact-type',
          summary: `The artifact type (${ARTIFACT_TYPES.map(v => input(v)).join(', ')})`,
          type: String,
          spec: { value: 'name' },
        },
        {
          name: 'skip-download',
          summary: `Skip downloading build artifacts after command succeeds.`,
          type: Boolean,
          spec: { value: 'name' },
          default: false,
        },
      ],
    };
  }

  async preRun(inputs: CommandLineInputs, options: CommandLineOptions): Promise<void> {
    this.env.log.warn(IONIC_CLOUD_CLI_MIGRATION);

    if (!inputs[0]) {
      const platformInput = await this.env.prompt({
        type: 'list',
        name: 'platform',
        choices: PLATFORMS,
        message: `Platform to package:`,
        validate: v => combine(validators.required, contains(PLATFORMS, {}))(v),
      });

      inputs[0] = platformInput;
    }

    const buildTypes = inputs[0] === 'ios' ? IOS_BUILD_TYPES : ANDROID_BUILD_TYPES;

    // validate that the build type is valid for the platform
    let reenterBuildType = false;
    if (inputs[1] && !buildTypes.includes(inputs[1])) {
      reenterBuildType = true;
      this.env.log.nl();
      this.env.log.warn(`Build type ${strong(inputs[1])} incompatible for ${strong(inputs[0])}; please choose a correct one`);
    }

    if (!inputs[1] || reenterBuildType) {
      const typeInput = await this.env.prompt({
        type: 'list',
        name: 'type',
        choices: buildTypes,
        message: `Build type:`,
        validate: v => combine(validators.required, contains(buildTypes, {}))(v),
      });

      inputs[1] = typeInput;
    }

    if (options['target-platform']) {
      this.env.log.warn(`The ${input('--target-platform')} option has been deprecated. Please use ${input('--build-stack')}.`);
      options['build-stack'] = options['target-platform'];
    }

    if (options['security-profile']) {
      this.env.log.warn(`The ${input('--security-profile')} option has been deprecated. Please use ${input('--signing-certificate')}.`);
      options['signing-certificate'] = options['security-profile'];
    }

    // the signing certificate is mandatory for iOS packages, so prompting if it is missing
    if (inputs[0] === 'ios' && !options['signing-certificate']) {
      if (this.env.flags.interactive) {
        this.env.log.nl();
        this.env.log.warn(`A signing certificate is mandatory to build an iOS package`);
      }

      const securityProfileOption = await this.env.prompt({
        type: 'input',
        name: 'signing-certificate',
        message: `Signing Certificate Name:`,
      });

      options['signing-certificate'] = securityProfileOption;
    }

    // if destination is present, validate that a proper build type has been been specified
    if (options['destination'] && !APP_STORE_COMPATIBLE_TYPES.includes(inputs[1])) {
      throw new FatalException(`Build with type ${strong(String(inputs[1]))} cannot be deployed to App Store`);
    }

    if (options['artifact-type'] && (Array.isArray(options['artifact-type']) || typeof options['artifact-type'] === 'string')) {
      const artifactTypes = Array.isArray(options['artifact-type']) ? options['artifact-type'] : [options['artifact-type']];
      let unsupported: string[];

      switch (inputs[0]) {
        case 'android':
          unsupported = artifactTypes.filter(type => !ANDROID_ARTIFACT_TYPES.includes(type));
          break;
        case 'ios':
          unsupported = artifactTypes.filter(type => !IOS_ARTIFACT_TYPES.includes(type));
          break;
        default:
          throw new FatalException(`Unsupported platform ${inputs[0]}`);
      }

      if (unsupported.length) {
        throw new FatalException(`Unsupported artifact types for platform ${inputs[0]}: ${[...unsupported]}`);
      }
    }
  }

  async run(inputs: CommandLineInputs, options: CommandLineOptions): Promise<void> {
    if (!this.project) {
      throw new FatalException(`Cannot run ${input('ionic package build')} outside a project directory.`);
    }

    const token = await this.env.session.getUserToken();
    const appflowId = await this.project.requireAppflowId();
    const [ platform, buildType ] = inputs;

    if (!options.commit) {
      options.commit = (await this.env.shell.output('git', ['rev-parse', 'HEAD'], { cwd: this.project.directory })).trim();
      debug(`Commit hash: ${strong(options.commit)}`);
    }

    let build = await this.createPackageBuild(appflowId, token, platform, buildType, options);
    const buildId = build.job_id;

    const details = columnar([
      ['App ID', strong(appflowId)],
      ['Build ID', strong(buildId.toString())],
      ['Commit', strong(`${build.commit.sha.substring(0, 6)} ${build.commit.note}`)],
      ['Target Platform', strong(build.stack.friendly_name)],
      ['Build Type', strong(build.build_type)],
      ['Artifact Type(s)', options['artifact-type'] ? strong(`${options['artifact-type']}`.toUpperCase()) : weak('all available')],
      ['Security Profile', build.profile_tag ? strong(build.profile_tag) : weak('not set')],
      ['Environment', build.environment_name ? strong(build.environment_name) : weak('not set')],
      ['Native Config', build.native_config_name ? strong(build.native_config_name) : weak('not set')],
      ['Destination', build.distribution_credential_name ? strong(build.distribution_credential_name) : weak('not set')],
    ], { vsep: ':' });

    this.env.log.ok(
      `Build created\n` +
      details + '\n\n'
    );

    build = await this.tailBuildLog(appflowId, buildId, token);
    if (build.state !== 'success') {
      throw new Error(`Build ${build.state}`);
    }

    if (options['skip-download']) {
      return;
    }

    const availableArtifactTypes = build.artifacts.map((artifact) => artifact.artifact_type);

    if (Array.isArray(options['artifact-type'])) {
      let errors = [];
      for (const artifactType of new Set(options['artifact-type'])) {
        try {
          await this.downloadArtifact(appflowId, buildId, artifactType, token, options);
        } catch (error) {
          errors.push(error);
        }
      }

      if (errors.length) {
        throw new FatalException(`There were issues downloading artifacts: ${errors.join('\n')}`);
      }

    } else if (typeof options['artifact-type'] == 'string') {
      await this.downloadArtifact(appflowId, buildId, options['artifact-type'], token, options);
    } else {
      for (const artifactType of availableArtifactTypes) {
        await this.downloadArtifact(appflowId, buildId, artifactType.toUpperCase(), token, options);
      }
    }
  }

  async sanitizeString(value: string | string[] | boolean | null | undefined): Promise<string> {

    if (!value || typeof (value) !== 'string') {
      return '';
    }

    if (!fileUtils.isValidFileName(value)) {
      throw new FatalException(`${strong(String(value))} is not a valid file name`);
    }

    return String(value);
  }

  async createPackageBuild(appflowId: string, token: string, platform: string, buildType: string, options: CommandLineOptions): Promise<PackageBuild> {
    const { req } = await this.env.client.make('POST', `/apps/${appflowId}/packages/verbose_post`);
    req.set('Authorization', `Bearer ${token}`).send({
      platform,
      build_type: buildType,
      commit_sha: options.commit,
      stack_name: options['build-stack'],
      profile_name: options['signing-certificate'],
      environment_name: options.environment,
      native_config_name: options['native-config'],
      distribution_credential_name: options.destination,
    });

    try {
      const res = await this.env.client.do(req);
      return res.data as PackageBuild;
    } catch (e) {
      if (isSuperAgentError(e)) {
        if (e.response.status === 401) {
          this.env.log.error('Try logging out and back in again.');
        }
        const apiErrorMessage = (e.response.body.error && e.response.body.error.message) ? e.response.body.error.message : 'Api Error';
        throw new FatalException(`Unable to create build: ` + apiErrorMessage);
      } else {
        throw e;
      }
    }
  }

  async getPackageBuild(appflowId: string, buildId: number, token: string): Promise<PackageBuild> {
    const { req } = await this.env.client.make('GET', `/apps/${appflowId}/packages/${buildId}`);
    req.set('Authorization', `Bearer ${token}`).send();

    try {
      const res = await this.env.client.do(req);
      return res.data as PackageBuild;
    } catch (e) {
      if (isSuperAgentError(e)) {
        if (e.response.status === 401) {
          this.env.log.error('Try logging out and back in again.');
        }
        const apiErrorMessage = (e.response.body.error && e.response.body.error.message) ? e.response.body.error.message : 'Api Error';
        throw new FatalException(`Unable to get build ${buildId}: ` + apiErrorMessage);
      } else {
        throw e;
      }
    }
  }

  async getDownloadUrl(appflowId: string, buildId: number, artifactType: string, token: string): Promise<DownloadUrl> {
    const { req } = await this.env.client.make('GET', `/apps/${appflowId}/packages/${buildId}/download?artifact_type=${artifactType}`);
    req.set('Authorization', `Bearer ${token}`).send();

    try {
      const res = await this.env.client.do(req);
      return res.data as DownloadUrl;
    } catch (e) {
      if (isSuperAgentError(e)) {
        if (e.response.status === 401) {
          this.env.log.error('Try logging out and back in again.');
        }
        const apiErrorMessage = (e.response.body.error && e.response.body.error.message) ? e.response.body.error.message : 'Api Error';
        throw new FatalException(`Unable to get download URL for build ${buildId}: ` + apiErrorMessage);
      } else {
        throw e;
      }
    }
  }

  async tailBuildLog(appflowId: string, buildId: number, token: string): Promise<PackageBuild> {
    let build;
    let start = 0;
    const ws = this.env.log.createWriteStream(LOGGER_LEVELS.INFO, false);

    let isCreatedMessage = false;
    let errorsEncountered = 0;
    while (!(build && ['success', 'failed', 'canceled'].includes(build.state))) {
      try {
        await sleep(5000);
        build = await this.getPackageBuild(appflowId, buildId, token);
        if (build && build.state === 'created' && !isCreatedMessage) {
          ws.write(chalk.yellow('Concurrency limit reached: build will start as soon as other builds finish.'));
          isCreatedMessage = true;
        }
        const trace = build.job.trace;
        if (trace.length > start) {
          ws.write(trace.substring(start));
          start = trace.length;
        }
        errorsEncountered = 0;
      } catch (e) {
        // Retry up to 3 times in the case of an error.
        errorsEncountered++;
        ws.write(chalk.yellow(`Encountered error: ${e} while fetching build data retrying.`));
        if (errorsEncountered >= 3) {
          ws.write(chalk.red(`Encountered ${errorsEncountered} errors in a row. Job will now fail.`));
          throw e;
        }
      }
    }
    ws.end();

    return build;
  }

  async downloadBuild(url: string, filename: string): Promise<string> {
    const { req } = await createRequest('GET', url, this.env.config.getHTTPConfig());

    if (!filename) {
      req.on('response', res => {
        const contentDisposition = res.header['content-disposition'];
        filename = contentDisposition ? contentDisposition.split('=')[1].replace(/([/?<>*|\"])/g, '_') : 'output.bin';
      });
    }

    const tmpFile = tmpfilepath('ionic-package-build');
    const ws = fs.createWriteStream(tmpFile);
    await download(req, ws, {});
    fs.copyFileSync(tmpFile, filename);
    fs.unlinkSync(tmpFile);
    return filename;
  }

  async downloadArtifact(appflowId: string, buildId: number, artifactType: string, token: string, options: CommandLineOptions) {

    const url = await this.getDownloadUrl(appflowId, buildId, artifactType.toUpperCase(), token);

    if (!url.url) {
      throw new Error(`Artifact type '${artifactType}' not found`);
    }

    let customBuildFileName = '';

    if (options['build-file-name']) {
      this.env.log.warn(`The ${input('--build-file-name')} option has been deprecated. Please use ${input('--ipa-name')}, ${input('--apk-name')} or ${input('--{ artifact }-name')}.`);
      customBuildFileName = await this.sanitizeString(options['build-file-name']);
    } else {
      customBuildFileName = await this.sanitizeString(options[`${artifactType.toLowerCase()}-name`]);
    }

    const filename = await this.downloadBuild(url.url, customBuildFileName);
    this.env.log.ok(`Artifact downloaded: ${filename}`);
  }
}
