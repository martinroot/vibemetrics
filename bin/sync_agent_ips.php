<?php
declare(strict_types=1);

$libPath = '/var/www/wifepornhub.ru/icrm/money/lib.php';
$lib = file_get_contents($libPath);
if ($lib === false) {
    throw new RuntimeException('Cannot read network server registry config');
}
preg_match("/DB_USER='([^']*)'/", $lib, $user);
preg_match("/DB_PASS='([^']*)'/", $lib, $pass);
preg_match("/DB_NAME='([^']*)'/", $lib, $name);
$db = new mysqli('localhost', $user[1] ?? 'money', $pass[1] ?? '', $name[1] ?? 'money');
if ($db->connect_errno) {
    throw new RuntimeException('Cannot connect to network server registry');
}
$db->set_charset('utf8mb4');
$rows = $db->query("SELECT TRIM(ip) AS ip,
                           GROUP_CONCAT(DISTINCT code ORDER BY code SEPARATOR ',') AS server_codes
                    FROM servers
                    WHERE is_enabled = 1 AND ip IS NOT NULL AND TRIM(ip) <> ''
                    GROUP BY TRIM(ip)");
if ($rows === false) {
    throw new RuntimeException('Cannot query enabled network servers');
}

$servers = [];
while ($row = $rows->fetch_assoc()) {
    $ip = trim((string)$row['ip']);
    if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
        continue;
    }
    $codes = array_values(array_unique(array_filter(
        array_map('trim', explode(',', (string)$row['server_codes'])),
        static fn(string $code): bool => preg_match('/^[A-Za-z0-9_. -]{1,100}$/D', $code) === 1
    )));
    $servers[$ip] = $codes;
}
$rows->free();
$db->close();
ksort($servers, SORT_NATURAL);

$dir = '/etc/vibemetrics';
if (!is_dir($dir) && !mkdir($dir, 0755, true) && !is_dir($dir)) {
    throw new RuntimeException('Cannot create allowlist directory');
}
$path = $dir . '/agent-ips.json';
$tmp = $path . '.tmp.' . getmypid();
$json = json_encode($servers, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
if (file_put_contents($tmp, $json, LOCK_EX) === false) {
    throw new RuntimeException('Cannot write agent IP allowlist');
}
chmod($tmp, 0644);
if (!rename($tmp, $path)) {
    @unlink($tmp);
    throw new RuntimeException('Cannot replace agent IP allowlist');
}
echo 'Synced ' . count($servers) . " mapped agent server IPs\n";
