import { Alert, Box, Button, Divider, Stack, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { SectionCard } from '../../components/SectionCard';

/** 隐私说明：把"什么会联网、什么不会"写清楚，可被用户自己验证（R1/R2/R3）。 */
export function PrivacyPage(): JSX.Element {
  const navigate = useNavigate();
  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="h6" sx={{ fontSize: 20 }}>
          隐私说明
        </Typography>
        <Button size="small" onClick={() => navigate('/settings')}>
          返回
        </Button>
      </Box>

      <Alert severity="success" sx={{ mb: 1.5 }}>
        没有账号、没有云端、没有统计埋点。这一页写的东西，你可以自己抓包验证。
      </Alert>

      <Stack spacing={1.5}>
        <SectionCard title="数据存在哪" dense>
          <Typography variant="body2" color="text.secondary">
            只存在这台设备当前浏览器的本地数据库（IndexedDB）。换浏览器、清站点数据、卸载应用都会让它消失，
            所以我们反复提醒你导出加密备份。
          </Typography>
        </SectionCard>

        <SectionCard title="唯一的联网行为" dense>
          <Typography variant="body2" color="text.secondary">
            只有基金行情：请求 <code>fund.eastmoney.com</code> 和 <code>push2.eastmoney.com</code>，
            URL 里只有 6 位基金代码，不含份额、成本、金额。除此之外没有任何出站请求。
          </Typography>
          <Divider sx={{ my: 1 }} />
          <Typography variant="body2" color="text.secondary">
            截图识别（OCR）在本机 WASM 里跑，图片不上传；识别包也是同源下载，不走第三方 CDN，
            所以既不产生第三方追踪，也能在断网时工作。
          </Typography>
        </SectionCard>

        <SectionCard title="永远不会出现的东西" dense>
          <Typography variant="body2" color="text.secondary">
            没有登录、没有支付密码/验证码/卡号/身份证输入框，没有转账、代扣、绑卡、还款入口。
            这类信息一旦要输入，就说明产品走错了方向。
          </Typography>
        </SectionCard>

        <SectionCard title="备份文件的加密" dense>
          <Typography variant="body2" color="text.secondary">
            加密备份用 WebCrypto：PBKDF2-SHA256（60 万次）派生密钥，AES-256-GCM 加密。口令错误一定解不开，
            我们也没有任何后门或找回方式。
          </Typography>
        </SectionCard>

        <SectionCard title="对比基准" dense>
          <Typography variant="body2" color="text.secondary">
            所有"均值""趋势""对比"都只拿你自己的历史做基准。产品里不会出现"同龄人""同城平均""其他用户"这类数据。
          </Typography>
        </SectionCard>
      </Stack>
    </>
  );
}
