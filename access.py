ROLE_RANK = {"viewer": 1, "editor": 2, "owner": 3}
LINK_ROLES = ("viewer", "editor")

GRAPH_ACCESS_QUERY = (
    "SELECT graphs.*, graph_members.role AS member_role, graph_link_visits.opened_at AS visited_at,"
    " graph_placements.folder_id,"
    " owners.handle AS owner_handle, owners.display_name AS owner_display_name,"
    " owners.google_picture_url AS owner_google_picture_url"
    " FROM graphs JOIN users AS owners ON owners.id = graphs.owner_id"
    " LEFT JOIN graph_members ON graph_members.graph_id = graphs.id AND graph_members.user_id = :user"
    " LEFT JOIN graph_link_visits ON graph_link_visits.graph_id = graphs.id AND graph_link_visits.user_id = :user"
    " LEFT JOIN graph_placements ON graph_placements.graph_id = graphs.id AND graph_placements.user_id = :user"
    " WHERE graphs.deleted_at IS NULL"
)
LISTED = (
    " AND (graphs.owner_id = :user OR graph_members.user_id IS NOT NULL"
    " OR (graph_link_visits.user_id IS NOT NULL AND graphs.link_access IS NOT NULL))"
)


def role_of(row, user_id):
    if row["owner_id"] == user_id:
        return "owner"
    roles = [role for role in (row["member_role"], row["link_access"]) if role]
    return max(roles, key=ROLE_RANK.__getitem__) if roles else None


def at_least(role, minimum):
    return role is not None and ROLE_RANK[role] >= ROLE_RANK[minimum]


def access_row(db, graph_id, user_id):
    return db.execute(GRAPH_ACCESS_QUERY + " AND graphs.id = :id", {"user": user_id, "id": graph_id}).fetchone()


def graph_role(db, graph_id, user_id):
    row = access_row(db, graph_id, user_id)
    return role_of(row, user_id) if row else None
