import {
  Auto,
  execPromise,
  IPlugin,
  getCurrentBranch,
  validatePluginConfiguration
} from "@auto-it/core";
import * as t from "io-ts";
import { inc, ReleaseType } from "semver";
import { readFile, writeFile } from "./utils";

const VERSION_REGEX = /\d+\.\d+\.\d+/;

const pluginOptions = t.intersection([
  t.interface({
    registry: t.string
  }),
  t.partial({
    tagLatest: t.boolean,
    chart: t.string,
    chartPath: t.string,
  }),
]);

export type IHelmPluginOptions = t.TypeOf<typeof pluginOptions>;

export default class HelmPlugin implements IPlugin {
  name = "helm"

  private calculatedTags?: string[];

  constructor(private readonly options: IHelmPluginOptions) {
    this.options.chart = options.chart || process.env.CHART
    this.options.chartPath = options.chartPath || '.'
  }

  apply(auto: Auto) {

    auto.hooks.validateConfig.tapPromise(this.name, async(name, options) => {
      if (name === this.name) {
        return validatePluginConfiguration(this.name, pluginOptions, options)
      }
    });

    auto.hooks.beforeRun.tap(this.name, (rc) => {
      const helmPlugin = rc.plugins!.find(
        (plugin) =>
          plugin[0] === this.name
      ) as [string, IHelmPluginOptions];
      if (!helmPlugin?.[1]?.chart) {
        auto.checkEnv(this.name, "CHART");
      }
    });

    auto.hooks.getPreviousVersion.tapPromise(this.name, async() => {
      const version = await this.getVersion(auto)
      return version;
    });

    auto.hooks.version.tapPromise(
      this.name,
      async ({ bump, dryRun, quiet }) => {
        if (!auto.git) {
          return;
        }

        const [lastTag, newTag] = await this.getNewVersion(auto, bump as ReleaseType);

        if (dryRun && newTag) {
          if (quiet) {
            console.log(newTag);
          } else {
            auto.logger.log.info(`Would have published: ${newTag}`);
          }

          return;
        }

        if (!newTag) {
          auto.logger.log.info("No release found, doing nothing");
          return;
        }

        const prefixedTag = auto.prefixRelease(newTag);

        auto.logger.log.info(`Tagging new tag: ${lastTag} => ${prefixedTag}`);

        await this.writeNewVersion(lastTag, newTag, `${this.options.chartPath}/Chart.yaml`);

        this.calculatedTags = [newTag];

        if (this.options.tagLatest === true && !bump.startsWith("pre")) {
          this.calculatedTags.push("latest");
        }

      }
    );

    auto.hooks.canary.tapPromise(
      this.name,
      async ({ bump, canaryIdentifier, dryRun, quiet }) => {
        if (!auto.git) {
          return;
        }

        const [current, nextVersion] = await this.getNewVersion(auto, bump as ReleaseType);
        const canaryVersion = `${nextVersion}${canaryIdentifier}`

        if (dryRun) {
          if (quiet) {
            console.log(canaryVersion)
          } else {
            auto.logger.log.info(`Would have published: ${canaryVersion}`)
          }

          return;
        }

        await this.writeNewVersion(current, nextVersion, `${this.options.chartPath}/Chart.yaml`);

        await execPromise("helm", [
          "chart",
          "save",
          `${this.options.chartPath}`,
          `${this.options.registry}/${this.options.chart}:${canaryVersion}`
        ])

        auto.logger.verbose.info("Successfully built canary version");

        await execPromise("helm", [
          "chart",
          "push",
          `${this.options.registry}/${this.options.chart}:${canaryVersion}`
        ]);

        auto.logger.verbose.info("Successfully published canary version");

        return canaryVersion;

      }
    );

    auto.hooks.publish.tapPromise(this.name, async() => {
      auto.logger.log.info("Pushing new tag to GitHub");

      await this.calculatedTags!.forEach(async(tag) => {
        await execPromise("helm", [
          "chart",
          "save",
          `${this.options.chartPath}`,
          `${this.options.registry}/${this.options.chart}:${tag}`
        ]).catch((error) => {
          auto.logger.log.info(`Failed to save helm chart for tag: ${tag}`)
        })
      });

      await this.calculatedTags!.forEach(async(tag) => {
        await execPromise("helm", [
          "chart",
          "push",
          `${this.options.registry}/${this.options.chart}:${tag}`
        ]).catch((error) => {
          auto.logger.log.info(`Failed to publish helm chart for tag: ${tag}`)
        })
      });

      await execPromise("git", [
        "push",
        "--follow-tags",
        "--set-upstream",
        auto.remote,
        getCurrentBranch() || auto.baseBranch
      ])
    });

    auto.hooks.afterChangelog.tapPromise(this.name, async({commits}) => {

      const changedFiles = await execPromise("git", ["status", "--porcelain"])

      if (changedFiles) {
        await execPromise("git", ["add", `${this.options.chartPath}/Chart.yaml`])
        await execPromise("git", [
          "commit",
          "--no-verify",
          "-m",
          "Update chart version [skip ci]"
        ])
      }

    });

  }

  private async getNewVersion(auto: Auto, bump: ReleaseType) {
    const version = await this.getVersion(auto);
    const newTag = inc(version, bump)

    if (!newTag) {
      throw new Error(
        `The version "${version}" parsed from "${this.options.chartPath}/Chart.yaml" was invalid and could not be incremented`
      );
    }

    return [version, newTag]
  }

  private async writeNewVersion(version: string, newVersion: string, chartFile: string) {
    let content = await readFile(chartFile, { encoding: "utf8" });
    let replaced = content.replace(`version: ${version}`, `version: ${newVersion}`)
    await writeFile(chartFile, replaced);
  }

  private async getVersion(auto: Auto) {
    let content = await readFile(`${this.options.chartPath}/Chart.yaml`, {encoding: "utf8"});
    let version = content.match(/version:\s*([\S ]+)/);

    if (version?.[0].match(VERSION_REGEX)) {
      auto.logger.log.info(`Found version in ${this.options.chartPath}/Chart.yaml: ${version[1]}`);
      return version[1];
    }

    return ""
  }

}