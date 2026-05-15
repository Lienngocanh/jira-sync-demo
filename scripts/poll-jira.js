// scripts/poll-jira.js — Chạy bởi GitHub Actions mỗi 5 phút
// Kiểm tra trạng thái tất cả bug trên Jira, cập nhật file .md nếu có thay đổi

import { loadEnv }         from '../config/env.js';
import { GitHubClient }    from './github-client.js';
import { JiraClient }      from './jira-client.js';
import { parseBugsFromMd, updateBugStatus } from './sync-status.js';

const STATUS_MAP = {
  // Jira status (lowercase) → trạng thái trong .md
  'done'        : 'done',
  'closed'      : 'done',
  'resolved'    : 'done',
  'fixed'       : 'done',
  'in progress' : 'in progress',
  'to do'       : 'open',
  'open'        : 'open',
  'reopened'    : 'open',
};

async function main() {
  const cfg  = loadEnv();
  const gh   = new GitHubClient(cfg.github);
  const jira = new JiraClient(cfg.jira);

  console.log('🔄 Poll Jira → GitHub sync bắt đầu...\n');

  // 1. Lấy danh sách tất cả sprint file trong bugs/
  const files = await gh.listDir('bugs');
  const sprintFiles = files.filter(f => /sprint-.*\.md$/.test(f.name));

  if (!sprintFiles.length) {
    console.log('📂 Không có sprint file nào trong bugs/ — kết thúc.');
    return;
  }

  let totalUpdated = 0;

  for (const fileInfo of sprintFiles) {
    const filePath = `bugs/${fileInfo.name}`;
    console.log(`📂 Xử lý ${filePath}...`);

    const file = await gh.readFile(filePath);
    if (!file) continue;

    const bugs = parseBugsFromMd(file.content);
    const openBugs = bugs.filter(b => b.jiraKey && b.status !== 'done');

    if (!openBugs.length) {
      console.log(`   ⏭️  Không có bug nào cần kiểm tra\n`);
      continue;
    }

    console.log(`   🔍 Kiểm tra ${openBugs.length} bug(s) đang open...`);

    let fileContent  = file.content;
    let fileSha      = file.sha;
    let fileChanged  = false;
    const changes    = [];

    for (const bug of openBugs) {
      try {
        const issue     = await jira.getIssue(bug.jiraKey);
        const jiraStatus = issue.fields?.status?.name?.toLowerCase() || '';
        const mdStatus   = STATUS_MAP[jiraStatus];

        if (!mdStatus) {
          console.log(`   ⏭️  ${bug.bugId}/${bug.jiraKey}: status "${jiraStatus}" không cần sync`);
          continue;
        }

        if (mdStatus === bug.status) {
          console.log(`   ✅ ${bug.bugId}/${bug.jiraKey}: đã đồng bộ (${mdStatus})`);
          continue;
        }

        // Trạng thái khác nhau → cần cập nhật
        console.log(`   🔄 ${bug.bugId}/${bug.jiraKey}: ${bug.status} → ${mdStatus}`);
        fileContent = updateBugStatus(fileContent, bug.bugId, mdStatus, bug.jiraKey);
        fileChanged = true;
        changes.push(`${bug.bugId}: ${bug.status} → ${mdStatus}`);

      } catch (err) {
        console.warn(`   ⚠️  Không lấy được ${bug.jiraKey}: ${err.message}`);
      }
    }

    // Commit nếu có thay đổi
    if (fileChanged) {
      const commitMsg = `chore(sync): poll Jira → update ${changes.join(', ')}`;
      try {
        const result = await gh.writeFile(filePath, fileContent, commitMsg, fileSha);
        console.log(`   📤 Committed: ${result.commit.slice(0, 7)}`);
        console.log(`   📝 Changes: ${changes.join(' | ')}`);
        totalUpdated += changes.length;
      } catch (err) {
        console.error(`   ❌ Commit thất bại: ${err.message}`);
      }
    }

    console.log('');
  }

  console.log('─'.repeat(50));
  if (totalUpdated > 0) {
    console.log(`✅ Poll hoàn tất — đã cập nhật ${totalUpdated} bug(s)`);
  } else {
    console.log('✅ Poll hoàn tất — không có thay đổi nào');
  }
}

main().catch(err => {
  console.error('❌ Poll crash:', err.message);
  process.exit(1);
});
