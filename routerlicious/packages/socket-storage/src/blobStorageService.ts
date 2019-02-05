import * as api from "@prague/container-definitions";
import * as resources from "@prague/gitresources";
import * as gitStorage from "@prague/services-client";
import { buildHierarchy } from "@prague/utils";

/**
 * Document access to underlying storage
 */
export class DocumentStorageService implements api.IDocumentStorageService  {
    public get repositoryUrl(): string {
        return "";
    }

    constructor(tenantId: string, private id: string, public manager: gitStorage.GitManager) {
    }

    public async getSnapshotTree(version?: resources.ICommit): Promise<api.ISnapshotTree> {
        let requestVerion = version;
        if (!requestVerion) {
            const versions = await this.getVersions(this.id, 1);
            if (versions.length === 0) {
                return Promise.resolve<api.ISnapshotTree>(null);
            }
            requestVerion = versions[0];
        }
        const tree = await this.manager.getTree(requestVerion.tree.sha);
        return buildHierarchy(tree);
    }

    public async getVersions(sha: string, count: number): Promise<resources.ICommit[]> {
        const commits = await this.manager.getCommits(sha, count);
        return commits.map((commit) => this.translateCommit(commit));
    }

    public async read(sha: string): Promise<string> {
        const value = await this.manager.getBlob(sha);
        return value.content;
    }

    public async getContent(version: resources.ICommit, path: string): Promise<string> {
        const value = await this.manager.getContent(version.sha, path);
        return value.content;
    }

    public write(tree: api.ITree, parents: string[], message: string, ref: string): Promise<resources.ICommit> {
        const branch = ref ? `components/${this.id}/${ref}` : this.id;
        return this.manager.write(branch, tree, parents, message);
    }

    public async createBlob(file: Buffer): Promise<resources.ICreateBlobResponse> {
        return this.manager.createBlob(file.toString("base64"), "base64");
    }

    public getRawUrl(sha: string): string {
        return this.manager.getRawUrl(sha);
    }

    private translateCommit(details: resources.ICommitDetails): resources.ICommit {
        return {
            author: details.commit.author,
            committer: details.commit.committer,
            message: details.commit.message,
            parents: details.parents,
            sha: details.sha,
            tree: details.commit.tree,
            url: details.commit.url,
        };
    }
}
