import { FakeContract, MockContract, MockContractFactory, smock } from '@defi-wonderland/smock';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import IUniswapV3PoolArtifact from '@solidity/for-test/IUniswapV3PoolForTest.sol/IUniswapV3PoolForTest.json';
import IKeep3rV1Artifact from '@solidity/interfaces/external/IKeep3rV1.sol/IKeep3rV1.json';
import IKeep3rV1ProxyArtifact from '@solidity/interfaces/external/IKeep3rV1Proxy.sol/IKeep3rV1Proxy.json';
import IKeep3rHelperArtifact from '@solidity/interfaces/IKeep3rHelper.sol/IKeep3rHelper.json';
import {
  ERC20ForTest,
  ERC20ForTest__factory,
  IKeep3rV1,
  IKeep3rV1Proxy,
  IUniswapV3Pool,
  Keep3rHelper,
  Keep3rKeeperDisputableForTest,
  Keep3rKeeperDisputableForTest__factory,
} from '@types';
import { wallet } from '@utils';
import { onlySlasher } from '@utils/behaviours';
import { toUnit } from '@utils/bn';
import chai, { expect } from 'chai';
import { ethers } from 'hardhat';

chai.use(smock.matchers);

describe('Keep3rKeeperDisputable', () => {
  const randomKeeper = wallet.generateRandomAddress();
  let governance: SignerWithAddress;
  let slasher: SignerWithAddress;
  let disputer: SignerWithAddress;
  let keeperDisputable: MockContract<Keep3rKeeperDisputableForTest>;
  let helper: FakeContract<Keep3rHelper>;
  let keep3rV1: FakeContract<IKeep3rV1>;
  let keep3rV1Proxy: FakeContract<IKeep3rV1Proxy>;
  let oraclePool: FakeContract<IUniswapV3Pool>;
  let keeperDisputableFactory: MockContractFactory<Keep3rKeeperDisputableForTest__factory>;

  before(async () => {
    [governance, slasher, disputer] = await ethers.getSigners();

    keeperDisputableFactory = await smock.mock<Keep3rKeeperDisputableForTest__factory>('Keep3rKeeperDisputableForTest');
  });

  beforeEach(async () => {
    helper = await smock.fake(IKeep3rHelperArtifact);
    keep3rV1 = await smock.fake(IKeep3rV1Artifact);
    keep3rV1Proxy = await smock.fake(IKeep3rV1ProxyArtifact);
    oraclePool = await smock.fake(IUniswapV3PoolArtifact);
    oraclePool.token0.returns(keep3rV1.address);

    keeperDisputable = await keeperDisputableFactory.deploy(helper.address, keep3rV1.address, keep3rV1Proxy.address, oraclePool.address);
    await keeperDisputable.setVariable('slashers', { [slasher.address]: true });
    await keeperDisputable.setVariable('disputers', { [disputer.address]: true });
  });

  describe('slash', () => {
    onlySlasher(
      () => keeperDisputable,
      'slash',
      [slasher],
      () => [randomKeeper, keeperDisputable.address, 1]
    );

    beforeEach(async () => {
      keep3rV1.transfer.returns(true);
      keep3rV1.transferFrom.returns(true);

      await keeperDisputable.setVariable('bonds', {
        [randomKeeper]: { [keep3rV1.address]: toUnit(3) },
      });

      await keeperDisputable.connect(disputer).dispute(randomKeeper);
    });

    it('should revert if keeper is not disputed', async () => {
      const undisputedKeeper = wallet.generateRandomAddress();
      await expect(keeperDisputable.connect(slasher).slash(undisputedKeeper, keep3rV1.address, toUnit(0.123))).to.be.revertedWith(
        'NotDisputed()'
      );
    });

    it('should emit event', async () => {
      await expect(keeperDisputable.connect(slasher).slash(randomKeeper, keep3rV1.address, toUnit(0.123)))
        .to.emit(keeperDisputable, 'KeeperSlash')
        .withArgs(randomKeeper, slasher.address, toUnit(0.123));
    });

    it('should slash specified bond amount', async () => {
      await keeperDisputable.connect(slasher).slash(randomKeeper, keep3rV1.address, toUnit(2));
      expect(await keeperDisputable.bonds(randomKeeper, keep3rV1.address)).to.equal(toUnit(1));
    });
  });

  describe('revoke', () => {
    onlySlasher(() => keeperDisputable, 'revoke', [slasher], [randomKeeper]);

    beforeEach(async () => {
      await keeperDisputable.setKeeper(randomKeeper);
    });

    it('should revert if keeper was not disputed', async () => {
      await expect(keeperDisputable.connect(slasher).revoke(randomKeeper)).to.be.revertedWith('NotDisputed()');
    });

    context('when keeper was disputed', () => {
      beforeEach(async () => {
        await keeperDisputable.connect(disputer).dispute(randomKeeper);
      });

      it('should remove keeper', async () => {
        await keeperDisputable.connect(slasher).revoke(randomKeeper);
        expect(await keeperDisputable.isKeeper(randomKeeper)).to.equal(false);
      });

      it('should keep keeper disputed', async () => {
        await keeperDisputable.connect(slasher).revoke(randomKeeper);
        expect(await keeperDisputable.disputes(randomKeeper)).to.equal(true);
      });

      it('should emit event', async () => {
        await expect(keeperDisputable.connect(slasher).revoke(randomKeeper))
          .to.emit(keeperDisputable, 'KeeperRevoke')
          .withArgs(randomKeeper, slasher.address);
      });

      it('should slash all keeper KP3R bonds', async () => {
        await keeperDisputable.setVariable('bonds', {
          [randomKeeper]: { [keep3rV1.address]: toUnit(1) },
        });

        await keeperDisputable.connect(slasher).revoke(randomKeeper);

        expect(await keeperDisputable.bonds(randomKeeper, keep3rV1.address)).to.equal(toUnit(0));
      });
    });
  });

  describe('internal slash', () => {
    context('when using an ERC20 bond', () => {
      let erc20Factory: MockContractFactory<ERC20ForTest__factory>;
      let erc20: MockContract<ERC20ForTest>;

      before(async () => {
        erc20Factory = await smock.mock<ERC20ForTest__factory>('ERC20ForTest');
      });

      beforeEach(async () => {
        erc20 = await erc20Factory.deploy('Sample', 'SMP', keeperDisputable.address, toUnit(2));
        await keeperDisputable.setVariable('bonds', {
          [randomKeeper]: { [erc20.address]: toUnit(2) },
        });

        erc20.transfer.returns(true);
      });

      it('should not revert if transfer fails', async () => {
        erc20.transfer.reverts();
        await expect(keeperDisputable.internalSlash(randomKeeper, erc20.address, toUnit(1))).not.to.be.reverted;
      });

      it('should transfer tokens to governance', async () => {
        await keeperDisputable.internalSlash(randomKeeper, erc20.address, toUnit(1));

        expect(erc20.transfer).to.be.calledOnceWith(governance.address, toUnit(1));
      });

      it('should reduce keeper bonds', async () => {
        await keeperDisputable.internalSlash(randomKeeper, erc20.address, toUnit(1));
        expect(await keeperDisputable.bonds(randomKeeper, erc20.address)).to.equal(toUnit(1));
      });
    });

    context('when using a KP3R bond', () => {
      beforeEach(async () => {
        await keeperDisputable.setVariable('bonds', {
          [randomKeeper]: { [keep3rV1.address]: toUnit(2) },
        });
      });

      it('should reduce keeper bonds', async () => {
        await keeperDisputable.internalSlash(randomKeeper, keep3rV1.address, toUnit(1));
        expect(await keeperDisputable.bonds(randomKeeper, keep3rV1.address)).to.equal(toUnit(1));
      });
    });

    it('should not remove the dispute from the keeper', async () => {
      await keeperDisputable.connect(disputer).dispute(randomKeeper);
      await keeperDisputable.internalSlash(randomKeeper, keep3rV1.address, 0);
      expect(await keeperDisputable.disputes(randomKeeper)).to.equal(true);
    });
  });
});
