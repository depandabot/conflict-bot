const core = require("@actions/core");
const github = require("@actions/github");
const { execSync } = require("child_process");
const readFileSync = require("fs").readFileSync;

async function run4() {
  try {
    const token = core.getInput("github-token", { required: true });
    const octokit = github.getOctokit(token);

    const pullRequest = github.context.payload.pull_request;
    const repo = github.context.repo;

    const openPullRequests = await getOpenPullRequests(octokit, repo);
    const otherOpenPullRequests = openPullRequests.filter(
      (pr) => pr.number !== pullRequest.number
    );

    let conflictArray = [];

    for (const openPullRequest of otherOpenPullRequests) {
      const conflictData = await checkForConflicts({
        octokit,
        repo,
        pr1Number: pullRequest.number,
        pr2Number: openPullRequest.number,
      });

      if (Object.keys(conflictData).length > 0) {
        conflictArray.push({
          number: openPullRequest.number,
          user: openPullRequest.user.login,
          conflictData,
        });
      }
    }

    if (conflictArray.length > 0) {
      await createConflictComment({
        octokit,
        repo,
        prNumber: pullRequest.number,
        conflictArray,
      });
      await requestReviews({
        octokit,
        repo,
        prNumber: pullRequest.number,
        conflictArray,
        prAuthor: pullRequest.user.login,
      });
      await requestReviewsInConflictingPRs({
        octokit,
        repo,
        conflictArray,
        prAuthor: pullRequest.user.login,
      });
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function getOpenPullRequests(octokit, repo) {
  try {
    const { data: pullRequests } = await octokit.rest.pulls.list({
      owner: repo.owner,
      repo: repo.repo,
      state: "open",
      per_page: 100,
    });

    // Map the list to only contain relevant information (PR number and author)
    const openPullRequests = pullRequests.map((pr) => ({
      number: pr.number,
      user: pr.user,
    }));

    return openPullRequests;
  } catch (error) {
    console.error(`Error fetching open pull requests: ${error.message}`);
    throw error;
  }
}

async function checkForConflicts({ octokit, repo, pr1Number, pr2Number }) {
  const pr1Branch = await getBranchName(octokit, repo, pr1Number);
  const pr2Branch = await getBranchName(octokit, repo, pr2Number);

  if (!pr1Branch || !pr2Branch) {
    throw new Error("Failed to fetch branch name for one or both PRs.");
  }

  const pr1Files = await getChangedFiles(octokit, repo, pr1Number);
  const pr2Files = await getChangedFiles(octokit, repo, pr2Number);

  const overlappingFiles = pr1Files.filter((file) => pr2Files.includes(file));

  if (!overlappingFiles.length) {
    return [];
  }

  const conflictData = await attemptMerge(pr1Branch, pr2Branch);

  return conflictData;
}

async function getBranchName(octokit, repo, prNumber) {
  const { data: pr } = await octokit.rest.pulls.get({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
  });

  return pr.head.ref;
}

async function getChangedFiles(octokit, repo, prNumber) {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
  });

  return files.map((file) => file.filename);
}
function extractConflictingLineNumbers(filePath) {
  const fileContent = readFileSync(filePath, "utf8");
  const lines = fileContent.split("\n");

  console.log(`Total lines processed: ${lines.length}`);
  console.log(lines.slice(320).join("\n"));

  let lineCounter = 0;
  const conflictLines = [];
  let oursBlock = [];
  let theirsBlock = [];
  let inOursBlock = false;
  let inTheirsBlock = false;
  let conflictStartLine = 0;

  for (const line of lines) {
    if (!inOursBlock && !inTheirsBlock) {
      lineCounter++;  // Increment only outside of conflict blocks.
    }

    if (line.startsWith("<<<<<<< HEAD")) {
      inOursBlock = true;
      conflictStartLine = lineCounter;
      console.log(`Conflict started at line: ${conflictStartLine}`);
      continue;
    }

    if (line.startsWith("=======")) {
      inOursBlock = false;
      inTheirsBlock = true;
      console.log(`Switching to THEIRS block at line: ${lineCounter}`);
      continue;
    }

    if (line.startsWith(">>>>>>>")) {
      inTheirsBlock = false;
      console.log(`Conflict end detected at line: ${lineCounter}`);
      console.log('Comparing Ours and Theirs Block');
      console.log('Ours Block:', oursBlock);
      console.log('Theirs Block:', theirsBlock);

      oursBlock.forEach((ourLine, index) => {
        if (theirsBlock[index] !== undefined && ourLine !== theirsBlock[index]) {
          const actualLineNumber = conflictStartLine + index; 
          conflictLines.push(actualLineNumber);
          console.log(`Conflict detected at line: ${actualLineNumber}`);
          console.log(`Ours: ${ourLine}`);
          console.log(`Theirs: ${theirsBlock[index]}`);
        }
      });

      oursBlock = [];
      theirsBlock = [];
      continue;
    }

    if (inOursBlock) {
      oursBlock.push(line);
    } else if (inTheirsBlock) {
      theirsBlock.push(line);
    }
  }

  return conflictLines;
}




async function attemptMerge(pr1, pr2) {
  const conflictData = {};

  try {
    // Configure Git with a dummy user identity
    execSync(`git config user.email "action@github.com"`);
    execSync(`git config user.name "GitHub Action"`);

    // Fetch PR branches into temporary refs
    execSync(`git fetch origin ${pr1}:refs/remotes/origin/tmp_${pr1}`);
    execSync(`git fetch origin ${pr2}:refs/remotes/origin/tmp_${pr2}`);

    // Fetch the main branch
    execSync(`git fetch origin main:main`);
    
    // Merge main into PR1 in memory
    execSync(`git checkout refs/remotes/origin/tmp_${pr1}`);
    execSync(`git merge main --no-commit --no-ff`);

    // Merge main into PR2 in memory
    execSync(`git checkout refs/remotes/origin/tmp_${pr2}`);
    execSync(`git merge main --no-commit --no-ff`);

    // Attempt to merge PR2's branch into PR1 in memory without committing or fast-forwarding
    execSync(`git checkout refs/remotes/origin/tmp_${pr1}`);
    try {
      execSync(`git merge refs/remotes/origin/tmp_${pr2} --no-commit --no-ff`);
      console.log("Merge successful");
    } catch (mergeError) {
      const stdoutStr = mergeError.stdout.toString();
      if (stdoutStr.includes("Automatic merge failed")) {
        const output = execSync(
          "git diff --name-only --diff-filter=U"
        ).toString();
        const conflictFileNames = output.split("\n").filter(Boolean);

        for (const filename of conflictFileNames) {
          conflictData[filename] = extractConflictingLineNumbers(filename);
        }
      }
    }
  } catch (error) {
    console.error(`Error during merge process: ${error.message}`);
  } finally {
    execSync(`git reset --hard HEAD`); // Reset any changes
    // Cleanup by deleting temporary refs
    execSync(`git update-ref -d refs/remotes/origin/tmp_${pr1}`);
    execSync(`git update-ref -d refs/remotes/origin/tmp_${pr2}`);
  }

  return conflictData;
}

async function createConflictComment({
  octokit,
  repo,
  prNumber,
  conflictArray,
}) {
  try {
    let conflictMessage = "### Conflicts Found\n\n";

    for (const data of conflictArray) {
      conflictMessage += `<details>\n`;
      conflictMessage += `  <summary><strong>Author:</strong> @${data.user} - <strong>PR:</strong> #${data.number}</summary>\n`;

      for (const [fileName, lineNumbers] of Object.entries(data.conflictData)) {
        const pr = await octokit.rest.pulls.get({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: context.issue.number,
        });

        const fileSha = pr.data.files.find(
          (file) => file.filename === "your-filename"
        ).sha;
        const url = `https://github.com/${context.repo.owner}/${context.repo.repo}/pull/${context.issue.number}/files#diff-${fileSha}`;

        conflictMessage += `  - <strong>[${fileName}](${url}):</strong> ${
          lineNumbers.length > 1 ? "Lines" : "Line"
        } ${lineNumbers.join(", ")}\n`;
      }

      conflictMessage += `</details>\n\n`;
    }

    await octokit.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: prNumber,
      body: conflictMessage,
    });
  } catch (error) {
    console.error(`Error creating conflict comment: ${error.message}`);
    throw error;
  }
}

async function requestReviews({
  octokit,
  repo,
  prNumber,
  conflictArray,
  prAuthor,
}) {
  try {
    const reviewers = [
      ...new Set(
        conflictArray
          .map((conflict) => conflict.user)
          .filter((user) => user !== prAuthor)
      ),
    ];

    await octokit.rest.pulls.requestReviewers({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      reviewers: reviewers,
    });
  } catch (error) {
    console.error(`Error requesting reviews: ${error.message}`);
    throw error;
  }
}

async function requestReviewsInConflictingPRs({
  octokit,
  repo,
  conflictArray,
  prAuthor,
}) {
  try {
    for (const conflict of conflictArray) {
      if (conflict.user !== prAuthor) {
        // Request a review from the current PR author in each conflicting PR
        await octokit.rest.pulls.requestReviewers({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: conflict.number,
          reviewers: [prAuthor],
        });
      }
    }
  } catch (error) {
    console.error(
      `Error requesting reviews in conflicting PRs: ${error.message}`
    );
    throw error;
  }
}

run4();
