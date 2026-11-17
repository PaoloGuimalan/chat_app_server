// Creation templates only. Existing roles keep their configured exact grants.
const common = ["realm.post.submit", "realm.post.publish", "realm.invite.publish"];
const review = ["realm.post.review", "realm.post.takedown", "realm.invite.review", "realm.notifications.view"];
const admin = ["realm.update", "realm.invite.create", "realm.invite.revoke", "realm.request.approve",
  "realm.request.decline", "realm.member.view", "realm.member.add", "realm.member.remove",
  "realm.member.role.update", "realm.follower.remove", "realm.channel.create", "realm.media.update",
  "realm.post.archive", ...common, ...review];
const defaultRoleNames = { owner: "Owner", admin: "Admin", member: "Member" };
function templatePermissions(code, realmType) {
  if (code === "owner") return [];
  const grants = new Set(code === "admin" ? admin : ["realm.member.view", ...common]);
  if (code === "admin" && realmType !== "community") grants.add("realm.identity.act");
  if (["group", "server"].includes(realmType)) {
    grants.add("realm.invite.create"); grants.add("realm.member.add");
  }
  return [...grants].sort();
}
module.exports = { defaultRoleNames, templatePermissions };
